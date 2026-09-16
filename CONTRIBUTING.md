# Contributing to Trellis API

First off, thanks for taking the time to contribute! ❤️

All types of contributions are encouraged and valued. See the [Table of Contents](#table-of-contents) for different ways to help and details about how this project handles them. Please make sure to read the relevant section before making your contribution. It will make it a lot easier for us maintainers and smooth out the experience for all involved.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [I Have a Question](#i-have-a-question)
- [I Want To Contribute](#i-want-to-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Enhancements](#suggesting-enhancements)
  - [Your First Code Contribution](#your-first-code-contribution)
  - [Improving The Documentation](#improving-the-documentation)
- [Styleguides](#styleguides)
  - [Commit Messages](#commit-messages)
  - [TypeScript Styleguide](#typescript-styleguide)
- [Join The Project Team](#join-the-project-team)

## Code of Conduct

This project and everyone participating in it is governed by the [Trellis API Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to <conduct@trellis.example>.

## I Have a Question

Before you ask a question, it is best to search for existing [Issues](https://github.com/TRELLIS-STELLAR/Trellis-API/issues) that might help you. In case you have found a suitable issue and still need clarification, you can write your question in that issue. It is also advisable to search the internet for answers first.

If you still have questions, feel free to reach out via GitHub Discussions.

## I Want To Contribute

### Reporting Bugs

#### Before Submitting a Bug Report

- Make sure that you are using the latest version.
- Check that your issue hasn't already been reported.
- Collect information about the issue to help us fix it quickly.

#### How Do I Submit a Good Bug Report?

Use the bug report template to create a detailed issue. Include:
- A quick summary and/or background
- Steps to reproduce
- What you expected would happen
- What actually happens
- Notes (potentially including why you think this is happening)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. Create an issue and provide:
- A clear and descriptive title
- Step-by-step description of the suggested enhancement
- Current behavior vs. expected behavior
- Screenshots if applicable
- Explain why this enhancement would be useful

### Your First Code Contribution

1. Fork the repository
2. Clone your fork
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Run tests: `npm test`
6. Commit your changes
7. Push to your fork
8. Open a Pull Request

#### Local Development Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Start development server
npm run start:dev

# Run tests
npm run test

# Run linting
npm run lint
```

### Improving The Documentation

You can help improve documentation by:
- Adding missing descriptions
- Fixing typos and grammar
- Adding tutorials and guides
- Improving existing documentation

## Styleguides

### Commit Messages

Use conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `refactor:` for code refactoring
- `test:` for adding tests
- `chore:` for build/tooling changes

Example: `feat: add new wallet authentication provider`

### TypeScript Styleguide

- Follow the existing ESLint configuration
- Use TypeScript types for all functions and variables
- Write comprehensive JSDoc comments for public APIs
- Keep functions small and focused
- Write unit tests for all new features

## Join The Project Team

If you're interested in becoming a maintainer, reach out to the core team! We're always looking for passionate contributors to help grow the project.

---

Happy coding! 🚀