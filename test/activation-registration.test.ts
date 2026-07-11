import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    detectSlots: vi.fn(),
    resolvePackagePath: vi.fn(),
    contextUpdatedListener: undefined as undefined | ((context: any) => void),
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
  onPackageContextUpdated: vi.fn((listener: (context: any) => void) => {
    mocks.contextUpdatedListener = listener
    return { dispose: vi.fn() }
  }),
  resolvePackagePathForDocument: mocks.resolvePackagePath,
  logger: { info: vi.fn(), error: vi.fn() },
}))
vi.mock('../src/parser', () => ({
  clearDocumentAnalysis: vi.fn(),
  detectSlots: mocks.detectSlots,
  getDocumentSlotAnalysis: vi.fn(),
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
    getWorkspaceFolder: vi.fn(() => ({ uri: { fsPath: '/workspace' } })),
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  languages: {
    registerHoverProvider: mocks.registerHover,
  },
  CompletionItemKind: {},
}))

describe('activation registration', () => {
  beforeEach(() => {
    mocks.ensureContext.mockClear()
    mocks.detectSlots.mockClear()
    mocks.resolvePackagePath.mockReset()
    mocks.contextUpdatedListener = undefined
  })

  it('does not analyze a nested document with its parent package context', async () => {
    const nestedDocument = {
      languageId: 'vue',
      version: 1,
      uri: { fsPath: '/workspace/packages/child/App.vue', toString: () => 'file:///workspace/packages/child/App.vue' },
      getText: () => '<template />',
    }
    const vscode = await import('vscode')
    ;(vscode.window.visibleTextEditors as any).push({ document: nestedDocument })
    mocks.resolvePackagePath.mockResolvedValue('/workspace/packages/child/package.json')
    const { activate } = await import('../src/index')
    const context = { globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any
    await activate(context)

    mocks.contextUpdatedListener?.({
      pkgPath: '/workspace/package.json',
      generation: 1,
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    })
    await vi.waitFor(() => expect(mocks.resolvePackagePath).toHaveBeenCalled())
    expect(mocks.detectSlots).not.toHaveBeenCalled()
    ;(vscode.window.visibleTextEditors as any).length = 0
  })

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
    await vi.waitFor(() => expect(mocks.ensureContext).toHaveBeenCalled())
    expect(mocks.ensureContext).toHaveBeenCalledWith(
      '/workspace/App.vue',
      context,
      expect.any(Function),
      false,
      '/workspace',
    )
  })
})
