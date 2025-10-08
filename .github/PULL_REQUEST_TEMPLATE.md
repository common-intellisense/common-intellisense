## Summary

Please describe the changes in this PR. Keep it short and reference any issues if applicable.

This branch includes:
- Global Vitest test setup to stub VS Code and runtime-only modules.
- Suffix-match fallback for UI component lookup so bare/pascal names resolve to prefixed completion keys.
- Unit tests for suffix-match behavior and pagination lookup.
- Migration of ESLint ignore globs into `eslint.config.js`.
- Small cleanup: removal of thin wrapper files and unused helpers.

## Checklist
- [ ] I have run tests locally (vitest) and they pass.
- [ ] I have run `pnpm run build` and `pnpm run typecheck` locally.
- [ ] The changelog entry (if relevant) has been added.
- [ ] I have added reviewers or assignees if appropriate.

## Notes for reviewers
- Pay attention to `src/ui/utils.ts` and `src/parser.ts` for the suffix-match logic and heuristics.
- `test/setup.ts` contains mocked helpers for deterministic tests outside of VS Code.
