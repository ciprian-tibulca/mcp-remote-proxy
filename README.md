# mcp-remote-proxy

A lightweight MCP (Model Context Protocol) stdio proxy that forwards requests to a remote MCP HTTP server with OAuth2 client credentials authentication.

## Features

- **MCP stdio transport**: Reads JSON-RPC messages from stdin, writes responses to stdout
- **HTTP forwarding**: Forwards all MCP requests to a remote HTTP endpoint
- **OAuth2 Client Credentials**: Automatically acquires and manages access tokens
- **Automatic token refresh**: Refreshes token on 401/403 responses with single retry
- **Concurrency safe**: Uses single-flight pattern for token refresh under load
- **Cursor compatible**: Works seamlessly as an MCP server command in Cursor IDE
- **Zero interactive prompts**: All configuration via CLI args or environment variables
- **Secure**: Never logs secrets, Authorization headers are redacted

## Installation

### Via npm (when published)

```bash
npm install -g mcp-remote-proxy
```

### Via npx from GitHub

```bash
npx github:ciprian-tibulca/mcp-remote-proxy --remote-url https://api.example.com/mcp ...
```

### From source

```bash
git clone https://github.com/ciprian-tibulca/mcp-remote-proxy.git
cd mcp-remote-proxy
npm install
npm run build
npm link  # Makes 'mcp-remote-proxy' available globally
```

## Usage

### Command Line

```bash
mcp-remote-proxy \
  --remote-url https://api.example.com/mcp \
  --token-url https://auth.example.com/oauth/token \
  --client-id my-client-id \
  --client-secret my-client-secret \
  --scope "read write"
```

### Environment Variables

```bash
export MCP_REMOTE_URL=https://api.example.com/mcp
export MCP_TOKEN_URL=https://auth.example.com/oauth/token
export MCP_CLIENT_ID=my-client-id
export MCP_CLIENT_SECRET=my-client-secret
export MCP_SCOPE="read write"

mcp-remote-proxy
```

### CLI Options

| Option | Env Variable | Default | Description |
|--------|--------------|---------|-------------|
| `--remote-url` | `MCP_REMOTE_URL` | *required* | Remote MCP server base URL |
| `--token-url` | `MCP_TOKEN_URL` | *required* | OAuth2 token endpoint URL |
| `--client-id` | `MCP_CLIENT_ID` | *required* | OAuth2 client ID |
| `--client-secret` | `MCP_CLIENT_SECRET` | *required* | OAuth2 client secret |
| `--scope` | `MCP_SCOPE` | *optional* | OAuth2 scope(s) |
| `--remote-timeout-ms` | `MCP_REMOTE_TIMEOUT_MS` | `30000` | Remote call timeout in ms |
| `--token-timeout-ms` | `MCP_TOKEN_TIMEOUT_MS` | `10000` | Token call timeout in ms |
| `--log-level` | `MCP_LOG_LEVEL` | `info` | Log level: debug, info, warn, error, silent |
| `-h, --help` | | | Show help message |
| `-v, --version` | | | Show version |

## Cursor IDE Configuration

Add this to your Cursor MCP configuration file (`~/.cursor/mcp.json` or workspace `.cursor/mcp.json`):

### Using CLI arguments

```json
{
  "mcpServers": {
    "my-remote-server": {
      "command": "npx",
      "args": [
        "github:ciprian-tibulca/mcp-remote-proxy",
        "--remote-url", "https://api.example.com/mcp",
        "--token-url", "https://auth.example.com/oauth/token",
        "--client-id", "your-client-id",
        "--client-secret", "your-client-secret",
        "--scope", "mcp:read mcp:write"
      ]
    }
  }
}
```

### Using environment variables

```json
{
  "mcpServers": {
    "my-remote-server": {
      "command": "npx",
      "args": ["github:ciprian-tibulca/mcp-remote-proxy"],
      "env": {
        "MCP_REMOTE_URL": "https://api.example.com/mcp",
        "MCP_TOKEN_URL": "https://auth.example.com/oauth/token",
        "MCP_CLIENT_ID": "your-client-id",
        "MCP_CLIENT_SECRET": "your-client-secret",
        "MCP_SCOPE": "mcp:read mcp:write",
        "MCP_LOG_LEVEL": "warn"
      }
    }
  }
}
```

### Using a published npm package

```json
{
  "mcpServers": {
    "my-remote-server": {
      "command": "npx",
      "args": [
        "mcp-remote-proxy@latest",
        "--remote-url", "https://api.example.com/mcp",
        "--token-url", "https://auth.example.com/oauth/token",
        "--client-id", "your-client-id",
        "--client-secret", "your-client-secret"
      ]
    }
  }
}
```

### Using a local build

```json
{
  "mcpServers": {
    "my-remote-server": {
      "command": "node",
      "args": [
        "/path/to/mcp-remote-proxy/dist/cli.js",
        "--remote-url", "https://api.example.com/mcp",
        "--token-url", "https://auth.example.com/oauth/token",
        "--client-id", "your-client-id",
        "--client-secret", "your-client-secret"
      ]
    }
  }
}
```

## How It Works

1. **Startup**: The proxy validates configuration and acquires an initial OAuth2 access token
2. **Listening**: It reads newline-delimited JSON-RPC messages from stdin
3. **Forwarding**: Each message is forwarded to the remote MCP server via HTTP POST with Bearer token
4. **Response**: The remote response is written to stdout
5. **Token Refresh**: If the remote returns 401/403, the token is refreshed and the request is retried once

### Message Flow

```
┌─────────────┐    stdin     ┌──────────────────┐    HTTP POST     ┌─────────────────┐
│   Cursor    │ ──────────▶  │ mcp-remote-proxy │ ───────────────▶ │ Remote MCP      │
│   (client)  │              │                  │  + Bearer token  │ Server (HTTP)   │
│             │ ◀──────────  │                  │ ◀─────────────── │                 │
└─────────────┘    stdout    └──────────────────┘    JSON-RPC      └─────────────────┘
                                     │
                                     │ On 401/403
                                     ▼
                              ┌──────────────────┐
                              │ OAuth2 Token     │
                              │ Endpoint         │
                              └──────────────────┘
```

## Development

### Prerequisites

- Node.js 18+ (20+ recommended)
- npm

### Setup

```bash
git clone https://github.com/ciprian-tibulca/mcp-remote-proxy.git
cd mcp-remote-proxy
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
npm run lint:fix  # Auto-fix issues
```

### Type Check

```bash
npm run typecheck
```

### Local Testing

```bash
# Build and run locally
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | \
  node dist/cli.js \
    --remote-url https://api.example.com/mcp \
    --token-url https://auth.example.com/oauth/token \
    --client-id test \
    --client-secret secret
```

## Error Handling

The proxy returns standard JSON-RPC errors:

| Code | Name | Description |
|------|------|-------------|
| `-32700` | Parse Error | Invalid JSON received |
| `-32600` | Invalid Request | Invalid JSON-RPC structure |
| `-32601` | Method Not Found | Unknown method |
| `-32602` | Invalid Params | Invalid method parameters |
| `-32603` | Internal Error | Internal proxy error |
| `-32000` | Token Error | OAuth2 token acquisition failed |
| `-32001` | Remote Error | Remote server returned an error |
| `-32002` | Timeout Error | Request timed out |

## Security Considerations

- **Never commit secrets**: Use environment variables for client secrets
- **Redacted logs**: Authorization headers are automatically redacted in logs
- **stdout purity**: Only MCP JSON-RPC messages go to stdout; all logs go to stderr
- **HTTPS recommended**: Use HTTPS for both remote URL and token URL in production

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Run linter: `npm run lint`
6. Commit your changes: `git commit -m "Add my feature"`
7. Push to the branch: `git push origin feature/my-feature`
8. Open a Pull Request

## License

MIT

## Related Projects

- [mcp-remote](https://github.com/anthropics/mcp-remote) - Official MCP remote transport
- [Model Context Protocol](https://github.com/anthropics/model-context-protocol) - MCP specification
