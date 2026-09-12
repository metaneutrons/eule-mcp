# Contributing to eule-mcp

Thank you for improving eule-mcp. Contributions are made through focused pull
requests against `main`.

## Development

Use Node.js 24 (see `.nvmrc`) and pnpm 10.7.1. Run `pnpm install` and then
`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before opening a
pull request. The Rust helper additionally requires the toolchain in
`rust-toolchain.toml`; run `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked` from `helper/`.

Commits and pull requests use [Conventional Commits](https://www.conventionalcommits.org/).
Keep changes small, explain security-sensitive decisions, and add regression
tests for bug fixes. Never commit credentials, tokens, local databases, or
build artefacts.

## Pull requests

Describe the user-visible effect, the tests run, and any migration or release
impact. Maintainers merge by squash after the required CI checks pass.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md)
for private disclosure.
