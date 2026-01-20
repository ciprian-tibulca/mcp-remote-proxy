/**
 * JSON-RPC 2.0 types for MCP protocol
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * OAuth2 Token Response
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Cached token with metadata
 */
export interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt?: number; // Unix timestamp in ms
}

/**
 * Application configuration
 */
export interface AppConfig {
  remoteUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  remoteTimeoutMs: number;
  tokenTimeoutMs: number;
  logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Standard JSON-RPC error codes
 */
export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom error codes for this proxy
  TOKEN_ERROR: -32000,
  REMOTE_ERROR: -32001,
  TIMEOUT_ERROR: -32002,
} as const;
