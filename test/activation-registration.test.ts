import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let resolveCache!: (value: string) => void
  const cache = new Promise<string>((resolve) => { resolveCache = resolve })
  const commandHandlers = new Map<string, (...args: any[]) => any>()
  return {
    cache,
    resolveCache,
    commandHandlers,
    registerCommand: vi.fn((name: string, handler: (...args: any[]) => any) => {
      commandHandlers.set(name, handler)
      return { dispose: vi.fn() }
    }),
    createSelect: vi.fn(async () => []),
    setConfiguration: vi.fn(),
    uiConfiguration: undefined as any,
    registerCompletion: vi.fn(() => ({ dispose: vi.fn() })),
    registerHover: vi.fn(() => ({ dispose: vi.fn() })),
    registerCodeLens: vi.fn(() => ({ dispose: vi.fn() })),
    ensureContext: vi.fn(),
    detectSlots: vi.fn(),
    clearDocumentAnalysis: vi.fn(),
    getSlotAnalysis: vi.fn(),
    resolvePackagePath: vi.fn(),
    contextUpdatedListener: undefined as undefined | ((context: any) => void),
    textChangeListener: undefined as undefined | ((event: any) => void),
    closeListener: undefined as undefined | ((document: any) => void),
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
  clearDocumentAnalysis: mocks.clearDocumentAnalysis,
  detectSlots: mocks.detectSlots,
  getDocumentSlotAnalysis: mocks.getSlotAnalysis,
  findDynamicComponent: vi.fn(),
  getImportDeps: vi.fn(() => ({})),
  parser: vi.fn(),
  registerCodeLensProviderFn: mocks.registerCodeLens,
}))
vi.mock('@vscode-use/utils', () => ({
  addEventListener: vi.fn((name: string, listener: (event: any) => void) => {
    if (name === 'text-change')
      mocks.textChangeListener = listener
    return { dispose: vi.fn() }
  }),
  createCompletionItem: vi.fn(),
  createHover: vi.fn(),
  createMarkdownString: vi.fn(),
  createPosition: vi.fn(),
  createRange: vi.fn(),
  createSelect: mocks.createSelect,
  getActiveTextEditor: vi.fn(),
  getConfiguration: vi.fn((key: string) => key === 'common-intellisense.showSlots' ? true : key === 'common-intellisense.ui' ? mocks.uiConfiguration : undefined),
  getCurrentFileUrl: vi.fn(),
  getLocale: vi.fn(() => 'en'),
  getPosition: vi.fn(),
  getRootPath: vi.fn(() => '/workspace'),
  insertText: vi.fn(),
  message: { info: vi.fn(), error: vi.fn() },
  openExternalUrl: vi.fn(),
  registerCommand: mocks.registerCommand,
  registerCompletionItemProvider: mocks.registerCompletion,
  setConfiguration: mocks.setConfiguration,
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
    onDidCloseTextDocument: vi.fn((listener: (document: any) => void) => {
      mocks.closeListener = listener
      return { dispose: vi.fn() }
    }),
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
    mocks.clearDocumentAnalysis.mockClear()
    mocks.getSlotAnalysis.mockReset()
    mocks.resolvePackagePath.mockReset()
    mocks.contextUpdatedListener = undefined
    mocks.textChangeListener = undefined
    mocks.closeListener = undefined
    mocks.createSelect.mockClear().mockResolvedValue([])
    mocks.setConfiguration.mockClear()
    mocks.uiConfiguration = undefined
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
      revision: 1,
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    })
    await vi.waitFor(() => expect(mocks.resolvePackagePath).toHaveBeenCalled())
    expect(mocks.detectSlots).not.toHaveBeenCalled()
    ;(vscode.window.visibleTextEditors as any).length = 0
  })

  it('re-analyzes slots when a custom-source context revision is published', async () => {
    const document = {
      languageId: 'vue',
      version: 1,
      uri: { fsPath: '/workspace/App.vue', toString: () => 'file:///workspace/App.vue' },
      getText: () => '<template />',
    }
    const vscode = await import('vscode')
    ;(vscode.window.visibleTextEditors as any).push({ document })
    mocks.resolvePackagePath.mockResolvedValue('/workspace/package.json')
    mocks.getSlotAnalysis.mockReturnValue({ documentVersion: 1, packagePath: '/workspace/package.json', contextGeneration: 1, contextRevision: 1 })
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    mocks.contextUpdatedListener?.({
      pkgPath: '/workspace/package.json',
      generation: 1,
      revision: 2,
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    })
    await vi.waitFor(() => expect(mocks.detectSlots).toHaveBeenCalled())
    expect(mocks.detectSlots).toHaveBeenCalledWith(document, {}, {}, [], expect.objectContaining({
      packagePath: '/workspace/package.json',
      contextGeneration: 1,
      contextRevision: 2,
    }))
    ;(vscode.window.visibleTextEditors as any).length = 0
  })

  it('cancels pending slot analysis when a document closes', async () => {
    vi.useFakeTimers()
    const { activate } = await import('../src/index')
    const context = { globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any
    await activate(context)
    const document = {
      languageId: 'vue',
      version: 1,
      isClosed: false,
      uri: { fsPath: '/workspace/Closed.vue', toString: () => 'file:///workspace/Closed.vue' },
      getText: () => '<template />',
    }

    mocks.textChangeListener?.({ contentChanges: [{}], document })
    document.isClosed = true
    mocks.closeListener?.(document)
    await vi.advanceTimersByTimeAsync(250)

    expect(mocks.ensureContext).not.toHaveBeenCalledWith('/workspace/Closed.vue', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(mocks.detectSlots).not.toHaveBeenCalled()
    expect(mocks.clearDocumentAnalysis).toHaveBeenCalledWith(document.uri)
    vi.useRealTimers()
  })

  it('drops local document analysis entries across close and reopen', async () => {
    const { clearLocalDocumentAnalysis, getDocumentAnalysis } = await import('../src/index')
    const uri = { fsPath: '/workspace/Reopen.vue', toString: () => 'file:///workspace/Reopen.vue' }
    const oldDocument = { uri, version: 1, getText: () => 'old code' } as any
    const newDocument = { uri, version: 1, getText: () => 'new code' } as any

    expect(getDocumentAnalysis(oldDocument).code).toBe('old code')
    clearLocalDocumentAnalysis(uri as any)
    expect(getDocumentAnalysis(newDocument).code).toBe('new code')
  })

  it('picks UI libraries from the active editor package only', async () => {
    mocks.uiConfiguration = {
      '/workspace/package.json': ['antd5'],
      '/other/package.json': ['elementPlus2'],
    }
    mocks.ensureContext.mockResolvedValue({
      pkgPath: '/workspace/package.json',
      currentPkgUiNames: ['antd5', 'elementPlus2'],
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    })
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    await mocks.commandHandlers.get('common-intellisense.pickUI')?.()

    expect(mocks.createSelect).toHaveBeenCalledWith([
      { label: 'antd5', picked: true },
      { label: 'elementPlus2' },
    ], expect.any(Object))
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
