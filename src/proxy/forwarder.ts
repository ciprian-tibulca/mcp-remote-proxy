import type { JsonRpcMessage, JsonRpcResponse } from '../types.js';
import { JsonRpcErrorCodes } from '../types.js';
import { TokenManager, TokenError } from '../auth/tokenManager.js';
import { logger } from '../logger.js';
import { createErrorResponse, isRequest, isNotification } from '../mcp/stdio.js';

/**
 * Forwarder handles proxying MCP requests to a remote HTTP server
 * with OAuth2 authentication and automatic token refresh on 401/403
 */
export class Forwarder {
  private readonly remoteUrl: string;
  private readonly tokenManager: TokenManager;
  private readonly timeoutMs: number;
  
  // Session ID returned by the server after initialize
  private sessionId: string | null = null;

  constructor(options: {
    remoteUrl: string;
    tokenManager: TokenManager;
    timeoutMs: number;
  }) {
    this.remoteUrl = options.remoteUrl;
    this.tokenManager = options.tokenManager;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Forward an MCP message to the remote server
   * Returns the response for requests, null for notifications
   */
  async forward(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    // For notifications, forward and don't expect response
    if (isNotification(message)) {
      await this.sendToRemote(message, false);
      return null;
    }

    // For requests, forward and return response
    if (isRequest(message)) {
      const id = 'id' in message ? message.id : null;
      
      try {
        const response = await this.forwardWithRetry(message);
        return response;
      } catch (error) {
        logger.error('Failed to forward request', { 
          method: 'method' in message ? message.method : 'unknown',
          error: String(error) 
        });
        
        return this.errorToResponse(id as string | number | null, error);
      }
    }

    // If it's a response (shouldn't happen in normal flow), pass through
    if ('result' in message || 'error' in message) {
      return message;
    }

    // Unknown message type
    return createErrorResponse(
      null,
      JsonRpcErrorCodes.INVALID_REQUEST,
      'Unknown message type'
    );
  }

  /**
   * Forward a request with automatic token refresh on 401/403
   */
  private async forwardWithRetry(message: JsonRpcMessage): Promise<JsonRpcResponse> {
    // First attempt
    try {
      return await this.sendRequest(message);
    } catch (error) {
      // Check if this is an auth error that we should retry
      if (this.isAuthError(error)) {
        logger.info('Received auth error, refreshing token and retrying');
        
        // Invalidate the current token
        this.tokenManager.invalidateToken();
        
        // Get a fresh token (will use single-flight if multiple requests fail)
        try {
          await this.tokenManager.refreshToken();
        } catch (tokenError) {
          logger.error('Token refresh failed', { error: String(tokenError) });
          throw tokenError;
        }
        
        // Retry exactly once with the new token
        try {
          return await this.sendRequest(message);
        } catch (retryError) {
          logger.error('Retry after token refresh failed', { error: String(retryError) });
          throw retryError;
        }
      }
      
      // Not an auth error, don't retry
      throw error;
    }
  }

  /**
   * Send a request to the remote server
   */
  private async sendRequest(message: JsonRpcMessage): Promise<JsonRpcResponse> {
    const response = await this.sendToRemote(message, true);
    
    if (!response) {
      throw new RemoteError('No response received from remote server', 0);
    }

    // Get the original request id to ensure it's preserved in responses
    const originalId = 'id' in message ? message.id : null;

    // Check content type to determine how to parse
    const contentType = response.headers.get('content-type') || '';
    
    let data: JsonRpcResponse;
    
    if (contentType.includes('text/event-stream')) {
      // Parse SSE response
      data = await this.parseSSEResponse(response);
    } else {
      // Parse as JSON
      data = (await response.json()) as JsonRpcResponse;
    }
    
    // Validate it's a valid JSON-RPC response
    if (!data.jsonrpc || data.jsonrpc !== '2.0') {
      throw new RemoteError('Invalid JSON-RPC response from remote server', 0);
    }

    // Ensure the response has the correct id from the original request
    // Some servers return null or omit id on error responses
    if (originalId !== null && originalId !== undefined) {
      if (data.id === null || data.id === undefined) {
        data = { ...data, id: originalId };
      }
    }

    return data;
  }

  /**
   * Parse a Server-Sent Events response to extract JSON-RPC data
   * SSE format: 
   *   event: message
   *   data: {"jsonrpc": "2.0", ...}
   */
  private async parseSSEResponse(response: Response): Promise<JsonRpcResponse> {
    const text = await response.text();
    logger.debug('Parsing SSE response', { length: text.length });
    
    // Split into lines and find the data lines
    const lines = text.split('\n');
    const dataLines: string[] = [];
    
    for (const line of lines) {
      if (line.startsWith('data:')) {
        // Extract the data after "data:" (may have a space after colon)
        const data = line.slice(5).trim();
        if (data) {
          dataLines.push(data);
        }
      }
    }
    
    if (dataLines.length === 0) {
      throw new RemoteError('No data found in SSE response', 0);
    }
    
    // For MCP, we expect a single JSON-RPC response in the data
    // Multiple data lines might be continuation of the same JSON
    const jsonData = dataLines.join('');
    
    try {
      return JSON.parse(jsonData) as JsonRpcResponse;
    } catch (error) {
      logger.error('Failed to parse SSE data as JSON', { data: jsonData.slice(0, 200) });
      throw new RemoteError(
        `Failed to parse SSE response as JSON: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    }
  }

  /**
   * Normalize a message to ensure it has all required fields for the remote server.
   * Some servers require 'params' even when empty.
   */
  private normalizeMessage(message: JsonRpcMessage): JsonRpcMessage {
    // If it's a request or notification (has method), ensure params exists
    if ('method' in message) {
      const normalized = { ...message };
      if (!('params' in normalized) || normalized.params === undefined) {
        (normalized as Record<string, unknown>).params = {};
      }
      return normalized as JsonRpcMessage;
    }
    return message;
  }

  /**
   * Send a message to the remote server
   */
  private async sendToRemote(
    message: JsonRpcMessage,
    expectResponse: boolean
  ): Promise<Response | null> {
    const token = await this.tokenManager.getToken();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const method = 'method' in message ? message.method : 'unknown';
      
      // Normalize message to ensure params field exists
      const normalizedMessage = this.normalizeMessage(message);
      const requestBody = JSON.stringify(normalizedMessage);
      
      // Build headers, including session ID if we have one
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      };
      
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      logger.debug('Forwarding to remote', { 
        url: this.remoteUrl, 
        method,
        hasId: 'id' in message,
        hasSessionId: !!this.sessionId,
        body: requestBody,
      });

      const response = await fetch(this.remoteUrl, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      });

      // Capture session ID from response headers if present
      const newSessionId = response.headers.get('Mcp-Session-Id');
      if (newSessionId && newSessionId !== this.sessionId) {
        logger.debug('Received new session ID from server', { sessionId: newSessionId });
        this.sessionId = newSessionId;
      }

      logger.debug('Remote response', {
        status: response.status,
        contentType: response.headers.get('content-type'),
        sessionId: newSessionId,
      });

      // Check for auth errors
      if (response.status === 401 || response.status === 403) {
        const body = await response.text();
        throw new AuthError(
          `Authentication failed: ${response.status} ${response.statusText}`,
          response.status,
          body
        );
      }

      // Check for other HTTP errors - but try to extract JSON-RPC error if present
      if (!response.ok) {
        const body = await response.text();
        
        // Try to parse as JSON-RPC error response
        try {
          const jsonBody = JSON.parse(body) as { jsonrpc?: string; error?: unknown };
          if (jsonBody.jsonrpc === '2.0' && jsonBody.error) {
            // This is a valid JSON-RPC error response, let it pass through
            // by returning the response for parsing
            logger.debug('Received JSON-RPC error response from remote', { 
              status: response.status,
              error: jsonBody.error 
            });
            // Create a fake response with the body for parsing
            return new Response(body, {
              status: 200, // Treat as success for response parsing
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } catch {
          // Not valid JSON, fall through to throw RemoteError
        }
        
        throw new RemoteError(
          `Remote server error: ${response.status} ${response.statusText}: ${body}`,
          response.status
        );
      }

      if (expectResponse) {
        return response;
      }

      return null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if an error indicates an authentication failure
   */
  private isAuthError(error: unknown): boolean {
    if (error instanceof AuthError) {
      return true;
    }
    return false;
  }

  /**
   * Convert an error to a JSON-RPC error response
   */
  private errorToResponse(
    id: string | number | null,
    error: unknown
  ): JsonRpcResponse {
    if (error instanceof TokenError) {
      return createErrorResponse(
        id,
        JsonRpcErrorCodes.TOKEN_ERROR,
        `Token error: ${error.message}`,
        { statusCode: error.statusCode }
      );
    }

    if (error instanceof AuthError) {
      return createErrorResponse(
        id,
        JsonRpcErrorCodes.TOKEN_ERROR,
        `Authentication error: ${error.message}`,
        { statusCode: error.statusCode }
      );
    }

    if (error instanceof TimeoutError) {
      return createErrorResponse(
        id,
        JsonRpcErrorCodes.TIMEOUT_ERROR,
        error.message
      );
    }

    if (error instanceof RemoteError) {
      return createErrorResponse(
        id,
        JsonRpcErrorCodes.REMOTE_ERROR,
        error.message,
        { statusCode: error.statusCode }
      );
    }

    // Generic error
    return createErrorResponse(
      id,
      JsonRpcErrorCodes.INTERNAL_ERROR,
      `Internal error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Error thrown when authentication fails
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Error thrown when the remote server returns an error
 */
export class RemoteError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

/**
 * Error thrown when a request times out
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
