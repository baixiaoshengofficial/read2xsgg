# Repository Guidelines

## Project Structure & Modules

- `src/` contains the conversion service. Keep source-format logic in focused modules such as `converter.js`, `xbs.js`, and `siteAdapters.js`.
- `src/siteAnalyze/` holds website-analysis and media-discovery helpers; add new detection behavior there rather than growing route handlers.
- `bin/` contains the CLI and server entry points. `public/` is the browser UI, while `docs/xiangse/` documents the XBS rule format.
- Tests live in `test/` beside their subject area (for example, `test/converter.test.js`). `compose.yaml` defines deployment; `sources/` holds sample inputs.

## Setup, Build, and Run

Use Node.js 18 or newer.

```sh
npm ci                         # install locked dependencies
npm test                       # run the complete offline test suite
npm start                      # start the local conversion service
npm run convert -- input.json -o output.xbs
npm run validate:xbs -- output.xbs
docker compose up -d           # run the published container locally
```

Use `npm run test:live` or `npm run test:xbs-live` only when deliberately checking external sites; they require their corresponding opt-in environment variables and can fail because remote sites change.

## Coding Style & Naming

The project uses ESM JavaScript and the existing two-space indentation style. Prefer small, side-effect-light functions, `camelCase` for variables and functions, and descriptive module filenames such as `imageDecoder.js`. Preserve the established JSON/XBS field casing because it is consumed by 香色闺阁. No formatter or linter is configured, so match surrounding code and avoid unrelated reformatting. Update `package-lock.json` only when dependencies change.

## Testing Guidelines

Tests use Node's built-in `node:test` runner and should be named `*.test.js`. Add a regression test in the closest existing test file for every converter, pagination, URL-encoding, or media-rule fix. Keep default tests deterministic: mock or fixture network responses instead of calling live sources. Run `npm test` before opening a pull request and validate representative generated files with `npm run validate:xbs`.

## Commits and Pull Requests

Follow the repository's concise Conventional Commit style: `fix: recover JSON TOCs`, `feat: add media adapter`, or `chore: update compose config`. Keep each commit scoped to one behavior. Pull requests should explain the affected source types, include test commands and results, link relevant issues, and include screenshots for `public/` UI changes. Call out any intentionally unsupported or site-specific behavior.

## Security and Configuration

Keep tokens, cookies, and private source credentials out of commits. Put local settings in `.env`; review preflight and private-network options carefully before public deployment. Do not weaken URL validation or SSRF protections merely to make one source work.
