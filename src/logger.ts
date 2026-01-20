import type { LogLevel } from './types.js';

/**
 * Logger that outputs to stderr only (stdout is reserved for MCP protocol)
 */
class Logger {
  private level: LogLevel = 'info';
  private readonly levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
  };

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  private formatMessage(level: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    if (data !== undefined) {
      return `${base} ${JSON.stringify(data)}`;
    }
    return base;
  }

  /**
   * Redact sensitive values from objects for logging
   */
  private redactSensitive(data: unknown): unknown {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.redactSensitive(item));
    }

    const redacted: Record<string, unknown> = {};
    const sensitiveKeys = [
      'authorization',
      'client_secret',
      'clientSecret',
      'access_token',
      'accessToken',
      'password',
      'secret',
    ];

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some((sk) => lowerKey.includes(sk.toLowerCase()))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactSensitive(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      const safeData = data !== undefined ? this.redactSensitive(data) : undefined;
      process.stderr.write(this.formatMessage('debug', message, safeData) + '\n');
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      const safeData = data !== undefined ? this.redactSensitive(data) : undefined;
      process.stderr.write(this.formatMessage('info', message, safeData) + '\n');
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      const safeData = data !== undefined ? this.redactSensitive(data) : undefined;
      process.stderr.write(this.formatMessage('warn', message, safeData) + '\n');
    }
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog('error')) {
      const safeData = data !== undefined ? this.redactSensitive(data) : undefined;
      process.stderr.write(this.formatMessage('error', message, safeData) + '\n');
    }
  }
}

export const logger = new Logger();
