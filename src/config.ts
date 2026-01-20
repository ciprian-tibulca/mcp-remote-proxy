import type { AppConfig, LogLevel } from './types.js';

interface CliArgs {
  remoteUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  remoteTimeoutMs?: number;
  tokenTimeoutMs?: number;
  logLevel?: string;
}

const DEFAULT_REMOTE_TIMEOUT_MS = 30000;
const DEFAULT_TOKEN_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

/**
 * Parse command line arguments
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextArg = argv[i + 1];

    switch (arg) {
      case '--remote-url':
        args.remoteUrl = nextArg;
        i++;
        break;
      case '--token-url':
        args.tokenUrl = nextArg;
        i++;
        break;
      case '--client-id':
        args.clientId = nextArg;
        i++;
        break;
      case '--client-secret':
        args.clientSecret = nextArg;
        i++;
        break;
      case '--scope':
        args.scope = nextArg;
        i++;
        break;
      case '--remote-timeout-ms':
        args.remoteTimeoutMs = parseInt(nextArg, 10);
        i++;
        break;
      case '--token-timeout-ms':
        args.tokenTimeoutMs = parseInt(nextArg, 10);
        i++;
        break;
      case '--log-level':
        args.logLevel = nextArg;
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      case '--version':
      case '-v':
        printVersion();
        process.exit(0);
        break;
    }
  }

  return args;
}

function printHelp(): void {
  const help = `
mcp-remote-proxy - MCP stdio proxy for remote MCP HTTP servers

USAGE:
  mcp-remote-proxy [OPTIONS]

OPTIONS:
  --remote-url <url>        Remote MCP server base URL (required)
                            Env: MCP_REMOTE_URL
  
  --token-url <url>         OAuth2 token endpoint URL (required)
                            Env: MCP_TOKEN_URL
  
  --client-id <id>          OAuth2 client ID (required)
                            Env: MCP_CLIENT_ID
  
  --client-secret <secret>  OAuth2 client secret (required)
                            Env: MCP_CLIENT_SECRET
  
  --scope <scope>           OAuth2 scope (optional)
                            Env: MCP_SCOPE
  
  --remote-timeout-ms <ms>  Remote call timeout in ms (default: 30000)
                            Env: MCP_REMOTE_TIMEOUT_MS
  
  --token-timeout-ms <ms>   Token call timeout in ms (default: 10000)
                            Env: MCP_TOKEN_TIMEOUT_MS
  
  --log-level <level>       Log level: debug, info, warn, error, silent
                            (default: info) Env: MCP_LOG_LEVEL
  
  -h, --help                Show this help message
  -v, --version             Show version

EXAMPLES:
  # Using command line arguments
  mcp-remote-proxy --remote-url https://api.example.com/mcp \\
                   --token-url https://auth.example.com/oauth/token \\
                   --client-id my-client \\
                   --client-secret my-secret

  # Using environment variables
  export MCP_REMOTE_URL=https://api.example.com/mcp
  export MCP_TOKEN_URL=https://auth.example.com/oauth/token
  export MCP_CLIENT_ID=my-client
  export MCP_CLIENT_SECRET=my-secret
  mcp-remote-proxy
`;
  process.stderr.write(help);
}

function printVersion(): void {
  process.stderr.write('mcp-remote-proxy v1.0.0\n');
}

/**
 * Validate a URL string
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Merge CLI args with environment variables and validate
 */
export function loadConfig(args: CliArgs): AppConfig {
  const errors: string[] = [];

  // Remote URL (required)
  const remoteUrl = args.remoteUrl || process.env.MCP_REMOTE_URL;
  if (!remoteUrl) {
    errors.push('Remote URL is required. Use --remote-url or set MCP_REMOTE_URL');
  } else if (!isValidUrl(remoteUrl)) {
    errors.push(`Invalid remote URL: ${remoteUrl}. Must be a valid HTTP(S) URL.`);
  }

  // Token URL (required)
  const tokenUrl = args.tokenUrl || process.env.MCP_TOKEN_URL;
  if (!tokenUrl) {
    errors.push('Token URL is required. Use --token-url or set MCP_TOKEN_URL');
  } else if (!isValidUrl(tokenUrl)) {
    errors.push(`Invalid token URL: ${tokenUrl}. Must be a valid HTTP(S) URL.`);
  }

  // Client ID (required)
  const clientId = args.clientId || process.env.MCP_CLIENT_ID;
  if (!clientId) {
    errors.push('Client ID is required. Use --client-id or set MCP_CLIENT_ID');
  }

  // Client Secret (required)
  const clientSecret = args.clientSecret || process.env.MCP_CLIENT_SECRET;
  if (!clientSecret) {
    errors.push('Client secret is required. Use --client-secret or set MCP_CLIENT_SECRET');
  }

  // Scope (optional)
  const scope = args.scope || process.env.MCP_SCOPE;

  // Remote timeout
  const remoteTimeoutMsStr = process.env.MCP_REMOTE_TIMEOUT_MS;
  const remoteTimeoutMs = args.remoteTimeoutMs ?? 
    (remoteTimeoutMsStr ? parseInt(remoteTimeoutMsStr, 10) : DEFAULT_REMOTE_TIMEOUT_MS);
  if (isNaN(remoteTimeoutMs) || remoteTimeoutMs <= 0) {
    errors.push('Remote timeout must be a positive number');
  }

  // Token timeout
  const tokenTimeoutMsStr = process.env.MCP_TOKEN_TIMEOUT_MS;
  const tokenTimeoutMs = args.tokenTimeoutMs ?? 
    (tokenTimeoutMsStr ? parseInt(tokenTimeoutMsStr, 10) : DEFAULT_TOKEN_TIMEOUT_MS);
  if (isNaN(tokenTimeoutMs) || tokenTimeoutMs <= 0) {
    errors.push('Token timeout must be a positive number');
  }

  // Log level
  const logLevelStr = args.logLevel || process.env.MCP_LOG_LEVEL || DEFAULT_LOG_LEVEL;
  const logLevel = logLevelStr.toLowerCase() as LogLevel;
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    errors.push(`Invalid log level: ${logLevelStr}. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new ConfigurationError(errors);
  }

  return {
    remoteUrl: remoteUrl!,
    tokenUrl: tokenUrl!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    scope,
    remoteTimeoutMs,
    tokenTimeoutMs,
    logLevel,
  };
}

export class ConfigurationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Configuration errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}
