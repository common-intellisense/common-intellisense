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
    clearDocumentAnalysesForPackages: vi.fn(),
    getSlotAnalysis: vi.fn(),
    getPackageContext: vi.fn(),
    getDocumentContext: vi.fn(),
    resolvePackagePath: vi.fn(),
    openTextDocument: vi.fn(),
    applyEdit: vi.fn(async () => true),
    workspaceEdits: [] as any[],
    contextUpdatedListener: undefined as undefined | ((context: any) => void),
    textChangeListener: undefined as undefined | ((event: any) => void),
    configChangeListener: undefined as undefined | ((event: any) => void),
    invalidateContexts: vi.fn(),
    resetCustomSourcesForApprovalChange: vi.fn(async () => {}),
    closeListener: undefined as undefined | ((document: any) => void),
    manifestCreateListener: undefined as undefined | ((uri: any) => void),
    manifestDeleteListener: undefined as undefined | ((uri: any) => void),
    handlePackageManifestLifecycle: vi.fn(() => ({ packagePaths: [] as string[], documentPaths: [] as string[] })),
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
  getContextForDocumentPath: mocks.getDocumentContext,
  getContextForPackagePath: mocks.getPackageContext,
  getCurrentPkgUiNames: vi.fn(),
  handlePackageManifestLifecycle: mocks.handlePackageManifestLifecycle,
  invalidateContexts: mocks.invalidateContexts,
  resetCustomSourcesForApprovalChange: mocks.resetCustomSourcesForApprovalChange,
  onPackageContextsInvalidated: vi.fn(() => ({ dispose: vi.fn() })),
  onPackageContextUpdated: vi.fn((listener: (context: any) => void) => {
    mocks.contextUpdatedListener = listener
    return { dispose: vi.fn() }
  }),
  resolvePackagePathForDocument: mocks.resolvePackagePath,
  releaseDocumentContext: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}))
vi.mock('../src/services/ui-cache', () => ({
  invalidateRootPackageCacheForManifest: vi.fn(),
}))
vi.mock('../src/parser', () => ({
  clearDocumentAnalysesForPackages: mocks.clearDocumentAnalysesForPackages,
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
    if (name === 'config-change')
      mocks.configChangeListener = listener
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
vi.mock('vscode', () => {
  class WorkspaceEdit {
    entries: any[] = []
    constructor() { mocks.workspaceEdits.push(this) }
    insert(uri: any, position: any, text: string) { this.entries.push(['insert', uri, position, text]) }
    replace(uri: any, range: any, text: string) { this.entries.push(['replace', uri, range, text]) }
  }
  class Range { constructor(public start: any, public end: any) {} }
  return {
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
      createFileSystemWatcher: vi.fn(() => ({
        dispose: vi.fn(),
        onDidCreate: vi.fn((listener: (uri: any) => void) => {
          mocks.manifestCreateListener = listener
          return { dispose: vi.fn() }
        }),
        onDidDelete: vi.fn((listener: (uri: any) => void) => {
          mocks.manifestDeleteListener = listener
          return { dispose: vi.fn() }
        }),
      })),
      openTextDocument: mocks.openTextDocument,
      applyEdit: mocks.applyEdit,
      getWorkspaceFolder: vi.fn(() => ({ uri: { fsPath: '/workspace' } })),
      onDidCloseTextDocument: vi.fn((listener: (document: any) => void) => {
        mocks.closeListener = listener
        return { dispose: vi.fn() }
      }),
    },
    languages: {
      registerHoverProvider: mocks.registerHover,
    },
    Uri: { parse: (value: string) => ({ value, fsPath: value.replace('file://', ''), toString: () => value }) },
    WorkspaceEdit,
    Range,
    CompletionItemKind: {},
  }
})

describe('activation registration', () => {
  beforeEach(() => {
    mocks.ensureContext.mockClear()
    mocks.detectSlots.mockClear()
    mocks.clearDocumentAnalysis.mockClear()
    mocks.getSlotAnalysis.mockReset()
    mocks.getPackageContext.mockReset()
    mocks.getDocumentContext.mockReset()
    mocks.resolvePackagePath.mockReset()
    mocks.openTextDocument.mockReset()
    mocks.applyEdit.mockClear()
    mocks.workspaceEdits.length = 0
    mocks.contextUpdatedListener = undefined
    mocks.textChangeListener = undefined
    mocks.configChangeListener = undefined
    mocks.invalidateContexts.mockClear()
    mocks.resetCustomSourcesForApprovalChange.mockClear()
    mocks.closeListener = undefined
    mocks.manifestCreateListener = undefined
    mocks.manifestDeleteListener = undefined
    mocks.handlePackageManifestLifecycle.mockReset().mockReturnValue({ packagePaths: [], documentPaths: [] })
    mocks.createSelect.mockClear().mockResolvedValue([])
    mocks.setConfiguration.mockClear()
    mocks.uiConfiguration = undefined
  })

  it('routes context-required completions to the import command', async () => {
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    const registration = (mocks.registerCompletion.mock.calls as any[][]).find(call => typeof call[2] === 'function')
    const postProcess = registration?.[2] as ((item: any) => any) | undefined
    expect(postProcess).toBeTypeOf('function')
    if (!postProcess)
      throw new Error('completion post-processor was not registered')
    for (const params of [
      { isReact: false, requiresImport: true },
      { isReact: true },
    ]) {
      const item = postProcess({ params, snippet: '<Button />', loc: {} })
      expect(item.command.command).toBe('common-intellisense.import')
    }
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

  it('clears and rebuilds visible slot analysis after a nearer package manifest appears', async () => {
    const document = {
      languageId: 'vue',
      version: 1,
      isClosed: false,
      uri: { fsPath: '/workspace/packages/child/App.vue', toString: () => 'file:///workspace/packages/child/App.vue' },
      getText: () => '<template />',
    }
    const childContext = {
      pkgPath: '/workspace/packages/child/package.json',
      generation: 2,
      revision: 1,
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    }
    const vscode = await import('vscode')
    ;(vscode.window.visibleTextEditors as any).push({ document })
    mocks.handlePackageManifestLifecycle.mockReturnValue({ packagePaths: [], documentPaths: [document.uri.fsPath] })
    mocks.ensureContext.mockResolvedValue(childContext)

    const { activate } = await import('../src/index')
    const context = { globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any
    await activate(context)
    mocks.manifestCreateListener?.({ fsPath: '/workspace/packages/child/package.json' })

    await vi.waitFor(() => expect(mocks.detectSlots).toHaveBeenCalled())
    expect(mocks.clearDocumentAnalysis).toHaveBeenCalledWith(document.uri)
    expect(mocks.ensureContext).toHaveBeenCalledWith(document.uri.fsPath, context, mocks.detectSlots, false, '/workspace')
    expect(mocks.detectSlots).toHaveBeenCalledWith(document, {}, {}, [], expect.objectContaining({
      packagePath: childContext.pkgPath,
      contextGeneration: 2,
      contextRevision: 1,
    }), expect.objectContaining({ currentDocumentPath: document.uri.fsPath }))
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
    mocks.getPackageContext.mockReturnValue({
      pkgPath: '/workspace/package.json',
      generation: 1,
      revision: 2,
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    })
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    mocks.contextUpdatedListener?.({
      pkgPath: '/workspace/package.json',
      generation: 1,
      revision: 1,
      uiCompletions: {},
      optionsComponents: { prefix: [] },
    })
    await vi.waitFor(() => expect(mocks.detectSlots).toHaveBeenCalled())
    expect(mocks.detectSlots).toHaveBeenCalledWith(document, {}, {}, [], expect.objectContaining({
      packagePath: '/workspace/package.json',
      contextGeneration: 1,
      contextRevision: 2,
    }), { cacheMap: undefined, sourceScopes: undefined, localDeps: {}, currentDocumentPath: '/workspace/App.vue' })
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

  it('keeps only the latest analysis version per URI and reads each version once', async () => {
    const { getDocumentAnalysis, getDocumentAnalysisCacheSize } = await import('../src/index')
    const uri = { fsPath: '/workspace/Latest.vue', toString: () => 'file:///workspace/Latest.vue' }
    const getText = vi.fn(() => 'version one')
    const first = { uri, version: 1, getText } as any

    expect(getDocumentAnalysis(first).code).toBe('version one')
    expect(getDocumentAnalysis(first).code).toBe('version one')
    expect(getText).toHaveBeenCalledOnce()

    const nextGetText = vi.fn(() => 'version two')
    expect(getDocumentAnalysis({ uri, version: 2, getText: nextGetText } as any).code).toBe('version two')
    expect(nextGetText).toHaveBeenCalledOnce()
    expect(getDocumentAnalysisCacheSize()).toBeLessThanOrEqual(10)
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

  it('fully invalidates contexts when approval and context configuration change together', async () => {
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    mocks.configChangeListener?.({
      affectsConfiguration: (key: string) => key === 'common-intellisense.alias' || key === 'common-intellisense.legacyAdapterAllowlist',
    })

    expect(mocks.invalidateContexts).toHaveBeenCalledTimes(1)
    expect(mocks.resetCustomSourcesForApprovalChange).not.toHaveBeenCalled()
  })

  it('resets only custom sources when only adapter approval changes', async () => {
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    mocks.configChangeListener?.({
      affectsConfiguration: (key: string) => key === 'common-intellisense.legacyAdapterAllowlist',
    })
    await vi.waitFor(() => expect(mocks.resetCustomSourcesForApprovalChange).toHaveBeenCalledTimes(1))

    expect(mocks.invalidateContexts).not.toHaveBeenCalled()
  })

  it('applies import edits to the source document after completion insertion advances its version', async () => {
    const source = {
      languageId: 'typescriptreact',
      version: 4,
      uri: { fsPath: '/workspace/A.tsx', toString: () => 'file:///workspace/A.tsx' },
      getText: () => 'export default () => <Button />',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    }
    mocks.openTextDocument.mockResolvedValue(source)
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    await mocks.commandHandlers.get('common-intellisense.import')?.({
      data: { name: 'Button' },
      lib: 'ui',
      importWay: 'specifier',
      document: { uri: 'file:///workspace/A.tsx', version: 3 },
    })

    expect(mocks.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ value: 'file:///workspace/A.tsx' }))
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1)
    expect(mocks.workspaceEdits[0].entries[0][1]).toEqual(expect.objectContaining({ value: 'file:///workspace/A.tsx' }))
  })

  it('registers a template completion in an existing Vue Options API script', async () => {
    const code = `<template><Button /></template>\n<script>\nexport default { name: 'Page' }\n</script>`
    const source = {
      languageId: 'vue',
      version: 4,
      uri: { fsPath: '/workspace/App.vue', toString: () => 'file:///workspace/App.vue' },
      getText: () => code,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    }
    mocks.openTextDocument.mockResolvedValue(source)
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    await mocks.commandHandlers.get('common-intellisense.import')?.({
      data: { name: 'Button' },
      lib: 'ui',
      importWay: 'specifier',
      registerVueComponent: true,
      document: { uri: 'file:///workspace/App.vue', version: 3 },
    }, { start: { offset: code.indexOf('export default') } })

    const insertedText = mocks.workspaceEdits.flatMap(edit => edit.entries).map(entry => entry[3]).join('\n')
    expect(insertedText).toContain('import { Button } from "ui"')
    expect(insertedText).toContain('components: { Button }')
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed string component import params without throwing', async () => {
    const source = {
      languageId: 'typescriptreact',
      version: 3,
      uri: { fsPath: '/workspace/A.tsx', toString: () => 'file:///workspace/A.tsx' },
      getText: () => '',
      positionAt: () => ({ line: 0, character: 0 }),
    }
    mocks.openTextDocument.mockResolvedValue(source)
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    await expect(mocks.commandHandlers.get('common-intellisense.import')?.({
      data: 'Button',
      lib: 'ui',
      document: { uri: 'file:///workspace/A.tsx', version: 3 },
    })).resolves.toBeUndefined()
    expect(mocks.applyEdit).not.toHaveBeenCalled()
  })

  it('accepts a filtered completion after multiple document versions when its tag was inserted', async () => {
    mocks.openTextDocument.mockResolvedValue({
      languageId: 'typescriptreact',
      version: 8,
      uri: { fsPath: '/workspace/A.tsx', toString: () => 'file:///workspace/A.tsx' },
      getText: () => 'export default () => <Button />',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    })
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)
    await mocks.commandHandlers.get('common-intellisense.import')?.({
      data: { name: 'Button' },
      lib: 'ui',
      importWay: 'specifier',
      document: { uri: 'file:///workspace/A.tsx', version: 3 },
    })
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1)
  })

  it('rejects an import command from a stale package context revision', async () => {
    mocks.openTextDocument.mockResolvedValue({
      languageId: 'typescriptreact',
      version: 8,
      uri: { fsPath: '/workspace/A.tsx', toString: () => 'file:///workspace/A.tsx' },
      getText: () => 'export default () => <Button />',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    })
    mocks.getDocumentContext.mockReturnValue({ pkgPath: '/workspace/package.json', generation: 2, revision: 4 })
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    await mocks.commandHandlers.get('common-intellisense.import')?.({
      data: { name: 'Button' },
      lib: 'ui',
      importWay: 'specifier',
      document: {
        uri: 'file:///workspace/A.tsx',
        version: 3,
        packagePath: '/workspace/package.json',
        contextGeneration: 2,
        contextRevision: 3,
      },
    })

    expect(mocks.applyEdit).not.toHaveBeenCalled()
  })

  it('does not import when the selected component tag is absent', async () => {
    mocks.openTextDocument.mockResolvedValue({
      languageId: 'typescriptreact',
      version: 8,
      uri: { fsPath: '/workspace/A.tsx', toString: () => 'file:///workspace/A.tsx' },
      getText: () => 'const Button = factory()',
      positionAt: () => ({ line: 0, character: 0 }),
    })
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)
    await mocks.commandHandlers.get('common-intellisense.import')?.({
      data: { name: 'Button' },
      lib: 'ui',
      importWay: 'specifier',
      document: { uri: 'file:///workspace/A.tsx', version: 3 },
    })
    expect(mocks.applyEdit).not.toHaveBeenCalled()
  })

  it('rejects Vue slot edits for React source documents', async () => {
    const source = {
      languageId: 'typescriptreact',
      version: 2,
      uri: { fsPath: '/workspace/A.tsx', toString: () => 'file:///workspace/A.tsx' },
      getText: () => '<Button />',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    }
    mocks.openTextDocument.mockResolvedValue(source)
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)

    await mocks.commandHandlers.get('common-intellisense.slots')?.(
      { start: 0, end: 10, selfClosing: true, column: 1, sameLine: true },
      'footer',
      {},
      { uri: 'file:///workspace/A.tsx', version: 2, packagePath: '/workspace/package.json', contextGeneration: 1, contextRevision: 2 },
    )

    expect(mocks.applyEdit).not.toHaveBeenCalled()
  })

  it('applies slot edits only to the CodeLens source document', async () => {
    const source = {
      languageId: 'vue',
      version: 2,
      uri: { fsPath: '/workspace/A.vue', toString: () => 'file:///workspace/A.vue' },
      getText: () => '<Button></Button>',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    }
    const packageContext = { pkgPath: '/workspace/package.json', generation: 1, revision: 2, uiCompletions: {}, optionsComponents: { prefix: [] } }
    mocks.openTextDocument.mockResolvedValue(source)
    mocks.getDocumentContext.mockReturnValue(packageContext)
    const { activate } = await import('../src/index')
    await activate({ globalStorageUri: { fsPath: '/tmp/storage' }, subscriptions: [] } as any)
    await mocks.commandHandlers.get('common-intellisense.slots')?.(
      { start: 0, end: 17, tag: 'Button', selfClosing: false, column: 1, sameLine: true },
      'default',
      {},
      { uri: 'file:///workspace/A.vue', version: 2, packagePath: '/workspace/package.json', contextGeneration: 1, contextRevision: 2 },
    )
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1)
    expect(mocks.workspaceEdits[0].entries[0][1]).toEqual(expect.objectContaining({ value: 'file:///workspace/A.vue' }))
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
