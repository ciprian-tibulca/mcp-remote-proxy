import { createInterface, type Interface } from 'node:readline';
import type { JsonRpcMessage, JsonRpcResponse, JsonRpcError } from '../types.js';
import { JsonRpcErrorCodes } from '../types.js';
import { logger } from '../logger.js';

/**
 * Handler function type for processing MCP messages
 */
export type MessageHandler = (message: JsonRpcMessage) => Promise<JsonRpcResponse | null>;

/**
 * StdioTransport handles reading JSON-RPC messages from stdin
 * and writing responses to stdout.
 * 
 * Messages are newline-delimited JSON.
 */
export class StdioTransport {
  private readline: Interface | null = null;
  private handler: MessageHandler | null = null;
  private running = false;

  /**
   * Set the message handler
   */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Start listening for messages on stdin
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.readline = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => {
      void this.processLine(line);
    });

    this.readline.on('close', () => {
      logger.info('stdin closed, shutting down');
      this.running = false;
      process.exit(0);
    });

    logger.info('Stdio transport started, listening for MCP messages');
  }

  /**
   * Stop the transport
   */
  stop(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.running = false;
  }

  /**
   * Process a single line from stdin
   */
  private async processLine(line: string): Promise<void> {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }

    logger.debug('Received message', { length: trimmedLine.length });

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmedLine) as JsonRpcMessage;
    } catch (error) {
      logger.error('Failed to parse JSON-RPC message', { error: String(error) });
      // Send parse error for requests (but we don't know the id)
      this.writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JsonRpcErrorCodes.PARSE_ERROR,
          message: 'Parse error: Invalid JSON',
        },
      });
      return;
    }

    // Validate JSON-RPC structure
    if (!this.isValidJsonRpc(message)) {
      logger.error('Invalid JSON-RPC message structure');
      this.writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JsonRpcErrorCodes.INVALID_REQUEST,
          message: 'Invalid Request: Missing required JSON-RPC fields',
        },
      });
      return;
    }

    if (!this.handler) {
      logger.error('No message handler registered');
      return;
    }

    try {
      const response = await this.handler(message);
      if (response) {
        this.writeResponse(response);
      }
    } catch (error) {
      logger.error('Error handling message', { error: String(error) });
      // If this was a request (has id), send an error response
      if ('id' in message && message.id !== undefined) {
        this.writeResponse({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: JsonRpcErrorCodes.INTERNAL_ERROR,
            message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      }
    }
  }

  /**
   * Write a response to stdout
   */
  writeResponse(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    logger.debug('Sending response', { id: response.id, hasError: !!response.error });
    process.stdout.write(json + '\n');
  }

  /**
   * Validate basic JSON-RPC 2.0 structure
   */
  private isValidJsonRpc(message: unknown): message is JsonRpcMessage {
    if (typeof message !== 'object' || message === null) {
      return false;
    }

    const msg = message as Record<string, unknown>;

    // Must have jsonrpc: "2.0"
    if (msg.jsonrpc !== '2.0') {
      return false;
    }

    // If it has a method, it's a request or notification
    if ('method' in msg) {
      return typeof msg.method === 'string';
    }

    // If it has id and result/error, it's a response
    if ('id' in msg) {
      return 'result' in msg || 'error' in msg;
    }

    return false;
  }
}

/**
 * Create a JSON-RPC error response
 */
export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

/**
 * Check if a message is a request (has id and method)
 */
export function isRequest(message: JsonRpcMessage): boolean {
  return 'method' in message && 'id' in message && message.id !== undefined;
}

/**
 * Check if a message is a notification (has method but no id)
 */
export function isNotification(message: JsonRpcMessage): boolean {
  return 'method' in message && (!('id' in message) || message.id === undefined);
}
