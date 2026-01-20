# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2025-01-20

### Added

- Initial release
- MCP stdio proxy with JSON-RPC 2.0 support
- HTTP forwarding to remote MCP servers
- OAuth2 Client Credentials flow for authentication
- Automatic token refresh on 401/403 responses
- Single-flight pattern for concurrent token refresh
- Configurable timeouts for token and remote calls
- CLI with comprehensive argument and environment variable support
- Logging to stderr with configurable log levels
- Secret redaction in logs
- Cursor IDE MCP configuration examples
- GitHub Actions CI pipeline
- Comprehensive test suite

### Security

- Authorization headers are redacted in all log output
- Client secrets are never logged
- stdout is reserved exclusively for MCP protocol messages

---

## Release Template

## [X.Y.Z] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security improvements
