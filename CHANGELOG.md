# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - feat/ci-and-tests

### Breaking / Security

- Custom executable CommonJS adapters from `remoteUris`, `remoteNpmUris`, and `localUris` are now disabled by default. Migrate trusted sources to the data-only `schemaVersion: 1` manifest format. Legacy approval is scoped to an exact source identity and SHA-256 digest through `common-intellisense.legacyAdapterAllowlist`; executable adapters remain disabled in Restricted Mode. The deprecated global `allowLegacyAdapters` flag is retained only as an emergency compatibility escape hatch and authorizes every configured custom source.
- `remoteUris` now use a DNS-pinned direct HTTP transport for SSRF protection. VS Code `http.proxy` and the `HTTP_PROXY`/`HTTPS_PROXY` environment variables are no longer supported; environments that require an outbound proxy must use another custom-source mechanism.

- Add global Vitest test setup to stub VSCode and runtime-only modules for unit tests.
- Implement suffix-match fallback for UI component lookup so bare/pascal names (e.g. `Pagination`) can match prefixed completion keys (e.g. `ElPagination`).
- Added unit tests covering suffix-match behavior and a pagination lookup test.
- Migrate project ignore globs from `.eslintignore` into `eslint.config.js` `ignores` to remove deprecation warnings.
- Remove several thin wrapper files and unused test helpers; centralize imports to inner modules (`./services/fetch`, `./ui/*`).
- Fix issue #38 by resolving installed package versions from local package manifests instead of shelling out to npm/pnpm/yarn/bun at runtime.
- Add regression tests for package version resolution, including missing-package retries and cache refresh behavior.

### Notes

- Tests, build, and typecheck run locally and are green.
- The Vitest setup file (`test/setup.ts`) provides stable mocks for CI environments.
