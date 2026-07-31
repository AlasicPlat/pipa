# Contributing to Pipa

Thank you for helping improve Pipa. By submitting a contribution, you agree that it is licensed under Apache License 2.0.

## Before opening a change

- Use an Issue for a behavior change that needs product discussion. Security reports must follow `SECURITY.md` instead.
- Keep changes focused. Avoid unrelated formatting or refactors in the same Pull Request.
- Never commit real credentials, connection strings, database dumps, certificates or signing keys.
- Add or update tests that reproduce a bug or verify new behavior.
- Document functions, classes and non-obvious logic, including parameters, return values and side effects.

## Development setup

Install Node.js 20.19+ or 22.12+, pnpm 11, Rust stable, Xcode Command Line Tools and Docker. Then run:

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

Use `./scripts/verify-foundation.sh` for the full local gate, including the MySQL integration service. For a smaller change, run the relevant tests first and finish with:

```bash
pnpm test
pnpm build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

If Rust transport types change, run `pnpm bindings:generate` and commit the generated `src/bindings` files. CI rejects generated binding drift.

## Commits and Pull Requests

Use a short imperative subject that describes the outcome. Conventional prefixes such as `fix:`, `feat:`, `docs:`, `test:`, `build:` and `chore:` are preferred. Keep mechanically generated changes in the same commit as the source change that produced them.

A Pull Request should explain the problem, the chosen solution, verification performed, user-visible impact and any security or migration consideration. UI changes should include a screenshot when it materially helps review.
