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

    // Parse and return the response
    const data = (await response.json()) as JsonRpcResponse;
    
    // Validate it's a valid JSON-RPC response
    if (!data.jsonrpc || data.jsonrpc !== '2.0') {
      throw new RemoteError('Invalid JSON-RPC response from remote server', 0);
    }

    return data;
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
      logger.debug('Forwarding to remote', { 
        url: this.remoteUrl, 
        method,
        hasId: 'id' in message 
      });

      const response = await fetch(this.remoteUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
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

      // Check for other HTTP errors
      if (!response.ok) {
        const body = await response.text();
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
