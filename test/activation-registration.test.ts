import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let resolveCache!: (value: string) => void
  const cache = new Promise<string>((resolve) => { resolveCache = resolve })
  return {
    cache,
    resolveCache,
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    registerCompletion: vi.fn(() => ({ dispose: vi.fn() })),
    registerHover: vi.fn(() => ({ dispose: vi.fn() })),
    registerCodeLens: vi.fn(() => ({ dispose: vi.fn() })),
    ensureContext: vi.fn(),
  }
})

vi.mock('../src/services/fetch', () => ({
  clearFetchCaches: vi.fn(),
  configureCacheStorage: vi.fn(),
  getLocalCache: mocks.cache,
  localCacheUri: '/tmp/cache.json',
}))
vi.mock('../src/ui/ui-find', () => ({
  deactivateUICache: vi.fn(),
  ensureContextForPath: mocks.ensureContext,
  getContextForDocumentPath: vi.fn(),
  getCurrentPkgUiNames: vi.fn(),
  invalidateContexts: vi.fn(),
  onPackageContextsInvalidated: vi.fn(() => ({ dispose: vi.fn() })),
  onPackageContextUpdated: vi.fn(() => ({ dispose: vi.fn() })),
  logger: { info: vi.fn(), error: vi.fn() },
}))
vi.mock('../src/parser', () => ({
  clearDocumentAnalysis: vi.fn(),
  detectSlots: vi.fn(),
  findDynamicComponent: vi.fn(),
  getImportDeps: vi.fn(() => ({})),
  parser: vi.fn(),
  registerCodeLensProviderFn: mocks.registerCodeLens,
}))
vi.mock('@vscode-use/utils', () => ({
  addEventListener: vi.fn(() => ({ dispose: vi.fn() })),
  createCompletionItem: vi.fn(),
  createHover: vi.fn(),
  createMarkdownString: vi.fn(),
  createPosition: vi.fn(),
  createRange: vi.fn(),
  createSelect: vi.fn(),
  getActiveTextEditor: vi.fn(),
  getConfiguration: vi.fn(),
  getCurrentFileUrl: vi.fn(),
  getLocale: vi.fn(() => 'en'),
  getPosition: vi.fn(),
  getRootPath: vi.fn(() => '/workspace'),
  insertText: vi.fn(),
  message: { info: vi.fn(), error: vi.fn() },
  openExternalUrl: vi.fn(),
  registerCommand: mocks.registerCommand,
  registerCompletionItemProvider: mocks.registerCompletion,
  setConfiguration: vi.fn(),
  setCopyText: vi.fn(),
  updateText: vi.fn(),
}))
vi.mock('vscode', () => ({
  window: {
    activeTextEditor: {
      document: {
        languageId: 'vue',
        uri: { fsPath: '/workspace/App.vue', toString: () => 'file:///workspace/App.vue' },
        getText: () => '<template />',
      },
    },
    visibleTextEditors: [],
  },
  workspace: {
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  languages: {
    registerHoverProvider: mocks.registerHover,
  },
  CompletionItemKind: {},
}))

describe('activation registration', () => {
  it('registers providers and commands before the initial preload resolves', async () => {
    const { activate } = await import('../src/index')
    const context = { globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any

    const activation = activate(context)
    await Promise.resolve()

    expect(mocks.registerCommand).toHaveBeenCalledWith('common-intellisense.cleanCache', expect.any(Function))
    expect(mocks.registerCompletion).toHaveBeenCalled()
    expect(mocks.registerHover).toHaveBeenCalled()
    expect(mocks.registerCodeLens).toHaveBeenCalled()
    expect(mocks.ensureContext).not.toHaveBeenCalled()
    await expect(activation).resolves.toBeUndefined()

    mocks.resolveCache('done reading')
    await vi.waitFor(() => expect(mocks.ensureContext).toHaveBeenCalledTimes(1))
  })
})
