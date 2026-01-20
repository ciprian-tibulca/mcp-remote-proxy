import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { TokenManager, TokenError } from '../src/auth/tokenManager.js';

// Mock fetch globally
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

function createMockResponse(options: {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): Response {
  return {
    ok: options.ok,
    status: options.status || 200,
    statusText: '',
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

describe('TokenManager', () => {
  let tokenManager: TokenManager;

  beforeEach(() => {
    jest.clearAllMocks();
    tokenManager = new TokenManager({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      scope: 'read write',
      timeoutMs: 5000,
    });
  });

  describe('getToken', () => {
    it('should fetch a new token when none is cached', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          json: async () => ({
            access_token: 'new-token-123',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        })
      );

      const token = await tokenManager.getToken();

      expect(token).toBe('new-token-123');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify Basic Auth header is used
      const callArgs = mockFetch.mock.calls[0];
      const requestInit = callArgs[1] as RequestInit;
      const headers = requestInit.headers as Record<string, string>;
      
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(headers['Accept']).toBe('application/json');
      expect(headers['Authorization']).toMatch(/^Basic /);
      
      // Verify Basic Auth contains correct credentials
      const basicAuth = headers['Authorization'].replace('Basic ', '');
      const decoded = Buffer.from(basicAuth, 'base64').toString('utf-8');
      expect(decoded).toBe('test-client:test-secret');
    });

    it('should use cached token on subsequent calls', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          json: async () => ({
            access_token: 'cached-token-456',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        })
      );

      const token1 = await tokenManager.getToken();
      const token2 = await tokenManager.getToken();
      const token3 = await tokenManager.getToken();

      expect(token1).toBe('cached-token-456');
      expect(token2).toBe('cached-token-456');
      expect(token3).toBe('cached-token-456');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should include scope in token request and use Basic Auth', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          json: async () => ({
            access_token: 'token-with-scope',
            token_type: 'Bearer',
          }),
        })
      );

      await tokenManager.getToken();

      const callArgs = mockFetch.mock.calls[0];
      const requestInit = callArgs[1] as RequestInit;
      const body = requestInit.body as string;
      const headers = requestInit.headers as Record<string, string>;
      
      // Scope should be in the body
      expect(body).toContain('scope=read+write');
      expect(body).toContain('grant_type=client_credentials');
      
      // Credentials should be in Authorization header (Basic Auth), not in body
      expect(body).not.toContain('client_id');
      expect(body).not.toContain('client_secret');
      expect(headers['Authorization']).toMatch(/^Basic /);
    });

    it('should throw TokenError on failed token request', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 400,
          text: async () => 'Bad Request: Invalid client',
        })
      );

      await expect(tokenManager.getToken()).rejects.toThrow(TokenError);
    });

    it('should throw TokenError when response is missing access_token', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          json: async () => ({
            token_type: 'Bearer',
            // Missing access_token
          }),
        })
      );

      await expect(tokenManager.getToken()).rejects.toThrow(TokenError);
    });
  });

  describe('refreshToken', () => {
    it('should force fetch a new token even if cached', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'first-token',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'refreshed-token',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          })
        );

      // Get initial token
      const token1 = await tokenManager.getToken();
      expect(token1).toBe('first-token');

      // Force refresh
      const token2 = await tokenManager.refreshToken();
      expect(token2).toBe('refreshed-token');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('single-flight pattern', () => {
    it('should only make one request when multiple concurrent refreshes are requested', async () => {
      let resolveToken: (value: Response) => void;
      const tokenPromise = new Promise<Response>((resolve) => {
        resolveToken = resolve;
      });

      mockFetch.mockReturnValueOnce(tokenPromise);

      // Start multiple concurrent refresh requests
      const refresh1 = tokenManager.refreshToken();
      const refresh2 = tokenManager.refreshToken();
      const refresh3 = tokenManager.refreshToken();

      // Verify only one request was made
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Resolve the token request
      resolveToken!(
        createMockResponse({
          ok: true,
          json: async () => ({
            access_token: 'single-flight-token',
            token_type: 'Bearer',
          }),
        })
      );

      // All promises should resolve to the same token
      const [token1, token2, token3] = await Promise.all([refresh1, refresh2, refresh3]);
      expect(token1).toBe('single-flight-token');
      expect(token2).toBe('single-flight-token');
      expect(token3).toBe('single-flight-token');

      // Still only one request
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should allow new refresh after previous one completes', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'first-token',
              token_type: 'Bearer',
            }),
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'second-token',
              token_type: 'Bearer',
            }),
          })
        );

      const token1 = await tokenManager.refreshToken();
      expect(token1).toBe('first-token');

      const token2 = await tokenManager.refreshToken();
      expect(token2).toBe('second-token');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateToken', () => {
    it('should clear cached token and fetch new one on next getToken', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'original-token',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'new-token-after-invalidate',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          })
        );

      // Get initial token
      const token1 = await tokenManager.getToken();
      expect(token1).toBe('original-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Invalidate
      tokenManager.invalidateToken();

      // Next getToken should fetch new token
      const token2 = await tokenManager.getToken();
      expect(token2).toBe('new-token-after-invalidate');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('token expiry', () => {
    it('should refresh token when it is about to expire', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'short-lived-token',
              token_type: 'Bearer',
              expires_in: 10, // 10 seconds - will be within buffer
            }),
          })
        )
        .mockResolvedValueOnce(
          createMockResponse({
            ok: true,
            json: async () => ({
              access_token: 'refreshed-token',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          })
        );

      // Get initial token (short-lived)
      const token1 = await tokenManager.getToken();
      expect(token1).toBe('short-lived-token');

      // The token expires in 10s but buffer is 30s, so it's already "expired"
      // Next call should refresh
      const token2 = await tokenManager.getToken();
      expect(token2).toBe('refreshed-token');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeout handling', () => {
    it('should throw TokenError on timeout', async () => {
      // Create token manager with very short timeout
      const shortTimeoutManager = new TokenManager({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'test-client',
        clientSecret: 'test-secret',
        timeoutMs: 1, // 1ms timeout
      });

      // Mock fetch that never resolves
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 1000);
          })
      );

      await expect(shortTimeoutManager.getToken()).rejects.toThrow(TokenError);
    });
  });
});
