import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Forwarder } from '../src/proxy/forwarder.js';
import { TokenError } from '../src/auth/tokenManager.js';
import type { JsonRpcMessage, JsonRpcResponse } from '../src/types.js';
import { JsonRpcErrorCodes } from '../src/types.js';

// Create a mock TokenManager interface
interface MockTokenManager {
  getToken: jest.Mock<() => Promise<string>>;
  refreshToken: jest.Mock<() => Promise<string>>;
  invalidateToken: jest.Mock<() => void>;
}

// Mock fetch globally
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

function createMockTokenManager(): MockTokenManager {
  return {
    getToken: jest.fn<() => Promise<string>>().mockResolvedValue('test-token'),
    refreshToken: jest.fn<() => Promise<string>>().mockResolvedValue('refreshed-token'),
    invalidateToken: jest.fn<() => void>(),
  };
}

function createMockResponse(options: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText || '',
    json: options.json || (async () => ({})),
    text: options.text || (async () => ''),
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => createMockResponse(options),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bytes: async () => new Uint8Array(),
  } as Response;
}

describe('Forwarder', () => {
  let forwarder: Forwarder;
  let mockTokenManager: MockTokenManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTokenManager = createMockTokenManager();

    forwarder = new Forwarder({
      remoteUrl: 'https://api.example.com/mcp',
      tokenManager: mockTokenManager as unknown as import('../src/auth/tokenManager.js').TokenManager,
      timeoutMs: 5000,
    });
  });

  describe('forward requests', () => {
    it('should forward a request and return the response', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const expectedResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [] },
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => expectedResponse,
        })
      );

      const response = await forwarder.forward(request);

      expect(response).toEqual(expectedResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          }),
          body: JSON.stringify(request),
        })
      );
    });

    it('should forward notifications without expecting response', async () => {
      const notification: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
        })
      );

      const response = await forwarder.forward(notification);

      expect(response).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('401/403 retry with token refresh', () => {
    it('should retry once after 401 with refreshed token', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'test' },
      };

      const successResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 2,
        result: { success: true },
      };

      // First call returns 401
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'Token expired',
          })
        )
        // Second call succeeds
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            status: 200,
            json: async () => successResponse,
          })
        );

      const response = await forwarder.forward(request);

      expect(response).toEqual(successResponse);
      expect(mockTokenManager.invalidateToken).toHaveBeenCalledTimes(1);
      expect(mockTokenManager.refreshToken).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry once after 403 with refreshed token', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'test://resource' },
      };

      const successResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 3,
        result: { contents: [] },
      };

      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            text: async () => 'Access denied',
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            status: 200,
            json: async () => successResponse,
          })
        );

      const response = await forwarder.forward(request);

      expect(response).toEqual(successResponse);
      expect(mockTokenManager.invalidateToken).toHaveBeenCalledTimes(1);
      expect(mockTokenManager.refreshToken).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry more than once on auth failure', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {},
      };

      // Both calls return 401
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'Token expired',
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'Still unauthorized',
          })
        );

      const response = await forwarder.forward(request);

      // Should return error response, not throw
      expect(response).toHaveProperty('error');
      expect(response!.error!.code).toBe(JsonRpcErrorCodes.TOKEN_ERROR);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return error if token refresh fails', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {},
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Token expired',
        })
      );

      // Make token refresh fail
      mockTokenManager.refreshToken.mockRejectedValueOnce(
        new TokenError('Token refresh failed', 400)
      );

      const response = await forwarder.forward(request);

      expect(response).toHaveProperty('error');
      expect(response!.error!.code).toBe(JsonRpcErrorCodes.TOKEN_ERROR);
      expect(response!.error!.message).toContain('Token error');
    });
  });

  describe('error handling', () => {
    it('should return error response for non-auth HTTP errors', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {},
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => 'Server error',
        })
      );

      const response = await forwarder.forward(request);

      expect(response).toHaveProperty('error');
      expect(response!.error!.code).toBe(JsonRpcErrorCodes.REMOTE_ERROR);
      expect(response!.error!.message).toContain('500');
      // Should not retry on 500
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockTokenManager.refreshToken).not.toHaveBeenCalled();
    });

    it('should return timeout error when request times out', async () => {
      // Create forwarder with short timeout
      const shortTimeoutForwarder = new Forwarder({
        remoteUrl: 'https://api.example.com/mcp',
        tokenManager: mockTokenManager as unknown as import('../src/auth/tokenManager.js').TokenManager,
        timeoutMs: 10,
      });

      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {},
      };

      // Mock fetch that responds to abort signal
      mockFetch.mockImplementationOnce((_url, options) => {
        return new Promise((_resolve, reject) => {
          const signal = (options as RequestInit).signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      const response = await shortTimeoutForwarder.forward(request);

      expect(response).toHaveProperty('error');
      expect(response!.error!.code).toBe(JsonRpcErrorCodes.TIMEOUT_ERROR);
      expect(response!.error!.message).toContain('timed out');
    });

    it('should return error for invalid JSON-RPC response', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {},
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => ({ invalid: 'response' }), // Missing jsonrpc: "2.0"
        })
      );

      const response = await forwarder.forward(request);

      expect(response).toHaveProperty('error');
      expect(response!.error!.code).toBe(JsonRpcErrorCodes.REMOTE_ERROR);
      expect(response!.error!.message).toContain('Invalid JSON-RPC response');
    });
  });

  describe('message type handling', () => {
    it('should preserve request id in response', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 'string-id-123',
        method: 'tools/list',
        params: {},
      };

      const remoteResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 'string-id-123',
        result: { tools: [] },
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => remoteResponse,
        })
      );

      const response = await forwarder.forward(request);

      expect(response!.id).toBe('string-id-123');
    });

    it('should handle numeric request ids', async () => {
      const request: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/list',
        params: {},
      };

      const remoteResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 42,
        result: { tools: [] },
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          json: async () => remoteResponse,
        })
      );

      const response = await forwarder.forward(request);

      expect(response!.id).toBe(42);
    });
  });
});
