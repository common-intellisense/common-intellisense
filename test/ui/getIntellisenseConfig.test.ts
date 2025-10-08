import { describe, expect, it, vi } from 'vitest'

// Minimal, stable test: mock find-up so the function exits early and returns undefined.
vi.mock('find-up', () => ({ findUp: async () => undefined }))

// Lightweight mocks to avoid importing heavy runtime dependencies during tests.
vi.mock('@vscode-use/utils', () => ({
  getConfiguration: () => undefined,
  getLocale: () => 'en',
  getRootPath: () => undefined,
  createFakeProgress: () => undefined,
  message: { error: () => {} },
}))

vi.mock('vscode', () => ({
  MarkdownString: class {
    appendMarkdown() {}
    appendCodeblock() {}
    isTrusted = true
    supportHtml = true
  },
  CompletionItemKind: { Property: 1, Enum: 2 },
  Hover: class {},
  Range: class {},
  CompletionList: class {},
  CompletionItem: class {},
  Uri: { file: (s: string) => ({ fsPath: s }) },
}))

// Prevent heavy runtime modules from executing during import
vi.mock('@simon_he/translate', () => ({ default: () => async () => ['ok'] }))
vi.mock('get-lib-version', () => ({ getLibVersion: async () => '1.0.0' }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: () => {}, error: () => {} } }))

describe('getIntellisenseConfig (simple)', () => {
  it('returns undefined when package.json is not found', async () => {
    const { getIntellisenseConfig } = await import('../../src/ui/ui-utils')
    const res = await getIntellisenseConfig('non-existent-pkg', '/tmp/nowhere')
    expect(res).toBeUndefined()
  })
})
