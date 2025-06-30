# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2025-06-29

### Added
- Initial release of Qdrant MCP Server
- MCP protocol implementation for semantic code search
- OpenAI embeddings support with text-embedding-3-small model
- Background file indexing with automatic change detection
- Support for multiple programming languages
- Comprehensive documentation and examples
- Dual distribution via npm and pip
- Basic test suite
- Systemd service configuration
- Cost estimation and tracking features

### Features
- Natural language code search queries
- Incremental indexing for large codebases
- Configurable file patterns and exclusions
- Multiple embedding model support (OpenAI initially)
- Batch processing for efficient API usage
- Persistent vector storage in Qdrant

### Documentation
- Complete installation and setup guide
- API reference and examples
- Background indexer documentation
- Systemd setup instructions
- Contributing guidelines

[Unreleased]: https://github.com/steiner385/qdrant-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/steiner385/qdrant-mcp-server/releases/tag/v1.0.0