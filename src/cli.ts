#!/usr/bin/env node

import { parseArgs, loadConfig, ConfigurationError } from './config.js';
import { logger } from './logger.js';
import { StdioTransport } from './mcp/stdio.js';
import { TokenManager } from './auth/tokenManager.js';
import { Forwarder } from './proxy/forwarder.js';

/**
 * Main entry point for the MCP remote proxy
 */
async function main(): Promise<void> {
  // Parse CLI arguments (skip node and script path)
  const args = parseArgs(process.argv.slice(2));

  // Load and validate configuration
  let config;
  try {
    config = loadConfig(args);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`\nError: ${error.message}\n\n`);
      process.stderr.write('Use --help for usage information.\n');
      process.exit(1);
    }
    throw error;
  }

  // Configure logger
  logger.setLevel(config.logLevel);

  logger.info('Starting MCP remote proxy', {
    remoteUrl: config.remoteUrl,
    tokenUrl: config.tokenUrl,
    logLevel: config.logLevel,
  });

  // Create token manager
  const tokenManager = new TokenManager({
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
    timeoutMs: config.tokenTimeoutMs,
  });

  // Create forwarder
  const forwarder = new Forwarder({
    remoteUrl: config.remoteUrl,
    tokenManager,
    timeoutMs: config.remoteTimeoutMs,
  });

  // Pre-fetch a token to validate credentials early
  try {
    logger.info('Validating OAuth2 credentials...');
    await tokenManager.getToken();
    logger.info('OAuth2 credentials validated successfully');
  } catch (error) {
    logger.error('Failed to acquire initial token', { error: String(error) });
    process.stderr.write(
      `\nError: Failed to acquire OAuth2 token. Please check your credentials.\n`
    );
    process.stderr.write(`Details: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Create stdio transport
  const transport = new StdioTransport();

  // Set up message handler
  transport.onMessage(async (message) => {
    return forwarder.forward(message);
  });

  // Handle process signals
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down');
    transport.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down');
    transport.stop();
    process.exit(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: String(error), stack: error.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
    process.exit(1);
  });

  // Start listening for MCP messages
  transport.start();

  logger.info('MCP remote proxy ready');
}

// Run main
main().catch((error) => {
  process.stderr.write(`Fatal error: ${String(error)}\n`);
  process.exit(1);
});
