# Contributing to Qdrant MCP Server

We love your input! We want to make contributing to Qdrant MCP Server as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features
- Becoming a maintainer

## We Develop with Github

We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

## We Use [Github Flow](https://guides.github.com/introduction/flow/index.html)

Pull requests are the best way to propose changes to the codebase. We actively welcome your pull requests:

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Ensure the test suite passes.
5. Make sure your code lints.
6. Issue that pull request!

## Any contributions you make will be under the MIT Software License

In short, when you submit code changes, your submissions are understood to be under the same [MIT License](LICENSE) that covers the project. Feel free to contact the maintainers if that's a concern.

## Report bugs using Github's [issues](https://github.com/kindash/qdrant-mcp-server/issues)

We use GitHub issues to track public bugs. Report a bug by [opening a new issue](https://github.com/kindash/qdrant-mcp-server/issues/new); it's that easy!

## Write bug reports with detail, background, and sample code

**Great Bug Reports** tend to have:

- A quick summary and/or background
- Steps to reproduce
  - Be specific!
  - Give sample code if you can
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening, or stuff you tried that didn't work)

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/kindash/qdrant-mcp-server
   cd qdrant-mcp-server
   ```

2. **Install dependencies**
   ```bash
   # Node.js dependencies
   npm install
   
   # Python dependencies
   pip install -e ".[dev]"
   ```

3. **Set up pre-commit hooks**
   ```bash
   npm run setup-hooks
   ```

4. **Run tests**
   ```bash
   # JavaScript tests
   npm test
   
   # Python tests
   pytest
   ```

## Code Style

### JavaScript/TypeScript
- We use ESLint and Prettier
- Run `npm run lint` to check your code
- Run `npm run format` to auto-format

### Python
- We follow PEP 8
- Use Black for formatting: `black src/`
- Use flake8 for linting: `flake8 src/`
- Type hints are encouraged

## Testing

- Write unit tests for new functionality
- Ensure all tests pass before submitting PR
- Aim for >80% code coverage
- Include integration tests for major features

## Documentation

- Update README.md for user-facing changes
- Add docstrings to all public functions
- Include inline comments for complex logic
- Update examples if API changes

## Pull Request Process

1. Update the README.md with details of changes to the interface
2. Update the docs/ with any new functionality
3. Increase version numbers in any examples files and the README.md
4. The PR will be merged once you have the sign-off of two other developers

## Community

- Join our [Discord](https://discord.gg/kindash) for discussions
- Check out our [roadmap](https://github.com/kindash/qdrant-mcp-server/projects) for upcoming features
- Read our [Code of Conduct](CODE_OF_CONDUCT.md)

## License

By contributing, you agree that your contributions will be licensed under its MIT License.