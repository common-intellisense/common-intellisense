# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - feat/ci-and-tests

- Add global Vitest test setup to stub VSCode and runtime-only modules for unit tests.
- Implement suffix-match fallback for UI component lookup so bare/pascal names (e.g. `Pagination`) can match prefixed completion keys (e.g. `ElPagination`).
- Added unit tests covering suffix-match behavior and a pagination lookup test.
- Migrate project ignore globs from `.eslintignore` into `eslint.config.js` `ignores` to remove deprecation warnings.
- Remove several thin wrapper files and unused test helpers; centralize imports to inner modules (`./services/fetch`, `./ui/*`).

### Notes

- Tests, build, and typecheck run locally and are green.
- The Vitest setup file (`test/setup.ts`) provides stable mocks for CI environments.
