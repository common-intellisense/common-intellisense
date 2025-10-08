import { vi } from 'vitest'

// Mock @vscode-use/utils to prevent loading the real extension helpers
vi.mock('@vscode-use/utils', () => ({
  createRange: () => ({}),
  getActiveText: () => '',
  getActiveTextEditor: () => null,
  getActiveTextEditorLanguageId: () => '',
  getConfiguration: () => null,
  getCurrentFileUrl: () => '',
  getLineText: () => '',
  getLocale: () => 'en',
  getPosition: () => ({ position: { line: 0, character: 0 } }),
  getSelection: () => ({ lineText: '' }),
  insertText: () => {},
  message: { info: () => {} },
  openExternalUrl: () => {},
  registerCommand: () => {},
  registerCompletionItemProvider: () => {},
  setCopyText: () => Promise.resolve(),
  updateText: () => {},
  addEventListener: () => () => {},
  registerCodeLensProvider: () => {},
  createFilter: () => () => false,
  // logging helper used in ui-find
  createLog: (_name: string) => ({
    info: (..._args: any[]) => {},
    warn: (..._args: any[]) => {},
    error: (..._args: any[]) => {},
    debug: (..._args: any[]) => {},
  }),
  // progress helper used in services/fetch
  createFakeProgress: (_opts: any) => {
    try {
      if (_opts?.callback) {
        _opts.callback(() => {}, () => {})
      }
    }
    catch { /* ignore */ }
    return { dispose: () => {} }
  },
  getRootPath: () => require('node:process').cwd(),
}))

// Mock 'vscode' to avoid needing the real VSCode runtime in unit tests.
vi.mock('vscode', () => {
  class MarkdownString {
    isTrusted = false
    supportHtml = false
    appendMarkdown(_s: string) {}
    appendCodeblock(_s: string, _lang?: string) {}
  }
  class Range {}
  return {
    MarkdownString,
    Range,
    Uri: { file: (p: string) => ({ fsPath: p }) },
    CompletionItemKind: { Property: 10, Enum: 11, Event: 12 },
    Hover: class Hover {},
    CompletionItem: class CompletionItem {},
    CompletionList: class CompletionList {},
    ExtensionContext: class ExtensionContext {},
    ViewColumn: { Beside: 2 },
    languages: { registerHoverProvider: () => ({}) },
    window: { visibleTextEditors: [] },
  }
})

// Mock translate loader to avoid dynamic requires inside @simon_he/translate
vi.mock('@simon_he/translate', () => {
  // The real module exports a factory as default, so return an object with default
  return { default: () => {
    return async (_prefix: string, _lan: string) => ['translated']
  } }
})

// Mock heavy fetch/npm helper modules that perform Node-only dynamic requires
vi.mock('@simon_he/fetch-npm', () => ({
  fetchAndExtractPackage: async () => '',
}))

vi.mock('@simon_he/fetch-npm-cjs', () => ({
  fetchFromCjsForCommonIntellisense: async () => '',
}))

vi.mock('@simon_he/latest-version', () => ({
  latestVersion: async () => '0.0.0',
}))
