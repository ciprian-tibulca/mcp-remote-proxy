import type { CachedToken, TokenResponse } from '../types.js';
import { logger } from '../logger.js';

/**
 * TokenManager handles OAuth2 client credentials flow with:
 * - In-memory token caching
 * - Automatic refresh on expiry detection
 * - Single-flight pattern for concurrent refresh requests
 */
export class TokenManager {
  private cachedToken: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scope?: string;
  private readonly timeoutMs: number;

  // Buffer time before actual expiry to refresh token (30 seconds)
  private readonly expiryBufferMs = 30000;

  constructor(options: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
    timeoutMs: number;
  }) {
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = options.scope;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.cachedToken && !this.isTokenExpired(this.cachedToken)) {
      logger.debug('Using cached token');
      return this.cachedToken.accessToken;
    }

    // Token is expired or doesn't exist, need to refresh
    return this.refreshToken();
  }

  /**
   * Force a token refresh (used after 401/403 responses)
   * Uses single-flight pattern to prevent multiple concurrent refreshes
   */
  async refreshToken(): Promise<string> {
    // If there's already a refresh in progress, wait for it
    if (this.refreshPromise) {
      logger.debug('Waiting for in-flight token refresh');
      const token = await this.refreshPromise;
      return token.accessToken;
    }

    logger.info('Acquiring new access token');

    // Start a new refresh
    this.refreshPromise = this.fetchToken();

    try {
      const token = await this.refreshPromise;
      this.cachedToken = token;
      logger.info('Successfully acquired access token');
      return token.accessToken;
    } finally {
      // Clear the promise so future requests can refresh if needed
      this.refreshPromise = null;
    }
  }

  /**
   * Invalidate the current token (call after 401/403)
   */
  invalidateToken(): void {
    logger.debug('Invalidating cached token');
    this.cachedToken = null;
  }

  /**
   * Check if a token is expired (or close to expiring)
   */
  private isTokenExpired(token: CachedToken): boolean {
    if (!token.expiresAt) {
      // If no expiry info, assume it's still valid
      // It will be refreshed when we get a 401/403
      return false;
    }
    const now = Date.now();
    const expired = now >= token.expiresAt - this.expiryBufferMs;
    if (expired) {
      logger.debug('Token is expired or about to expire');
    }
    return expired;
  }

  /**
   * Fetch a new token from the OAuth2 token endpoint
   */
  private async fetchToken(): Promise<CachedToken> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Build request body - only grant_type and optional scope
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
      });

      if (this.scope) {
        body.append('scope', this.scope);
      }

      // Use HTTP Basic Authentication for client credentials
      // This is the standard OAuth2 approach used by many providers
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      logger.debug('Fetching token from OAuth2 endpoint', { url: this.tokenUrl });

      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Basic ${credentials}`,
        },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new TokenError(
          `Token request failed with status ${response.status}: ${errorBody}`,
          response.status
        );
      }

      const data = (await response.json()) as TokenResponse;

      if (!data.access_token) {
        throw new TokenError('Token response missing access_token', 0);
      }

      const cachedToken: CachedToken = {
        accessToken: data.access_token,
        tokenType: data.token_type || 'Bearer',
      };

      if (data.expires_in && typeof data.expires_in === 'number') {
        cachedToken.expiresAt = Date.now() + data.expires_in * 1000;
        logger.debug('Token expires in', { expiresIn: data.expires_in });
      }

      return cachedToken;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TokenError(`Token request timed out after ${this.timeoutMs}ms`, 0);
      }
      if (error instanceof TokenError) {
        throw error;
      }
      throw new TokenError(
        `Token request failed: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if this manager has an in-flight refresh
   */
  isRefreshing(): boolean {
    return this.refreshPromise !== null;
  }
}

export class TokenError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'TokenError';
  }
}
