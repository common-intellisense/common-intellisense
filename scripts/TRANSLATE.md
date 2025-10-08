translate-directives usage

This project includes a small script to translate `directives.json` under `src/ui/varlet`.

Usage (dry-run, safe):

- Run the script (dry-run):

  node scripts/translate-directives.js

- Produce a report (JSON) describing planned changes:

  node scripts/translate-directives.js --report --dir test/fixtures/translate-test/src/ui/varlet

- Produce a report with compact diffs:

  node scripts/translate-directives.js --report --diff --dir test/fixtures/translate-test/src/ui/varlet

- Apply changes (writes files):

  node scripts/translate-directives.js --apply --report --dir test/fixtures/translate-test/src/ui/varlet

Flags:
- --apply : actually write translated files (default is dry-run)
- --report: write a JSON report of planned changes to `translate-directives-report.json`
- --diff  : include a compact line-based diff in the report (works with --report)
- --dir <path> : override the target directory (useful for testing fixtures)
- --verbose: log each translation pair
 - --report-path <path> : write report to a custom path instead of the default `translate-directives-report.json`

Notes:
- The script uses `bing-translate-api` if available; otherwise it falls back to a no-op translator that returns the input text.
- Use the `--report` mode first to verify planned changes before `--apply`.
 - Use `--report-path` to control where the JSON report is written.
