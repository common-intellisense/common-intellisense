import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUpMock, fetchMock, localFetchMock, remoteFetchMock, npmFetchMock } = vi.hoisted(() => ({
  findUpMock: vi.fn(),
  fetchMock: vi.fn(),
  localFetchMock: vi.fn(async (_root?: string) => ({})),
  remoteFetchMock: vi.fn(async () => ({})),
  npmFetchMock: vi.fn(async () => ({})),
}))

vi.mock('find-up', () => ({ findUp: findUpMock }))
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify({ dependencies: { antd: '^5.0.0' } })),
    writeFile: vi.fn(),
    access: vi.fn(),
  },
}))
vi.mock('../../src/services/fetch', () => ({
  fetchFromCommonIntellisense: fetchMock,
  fetchLocalSourceResults: async (root?: string) => [{ id: 'local:test', status: 'success', value: await localFetchMock(root) }],
  fetchRemoteNpmSourceResults: async () => [{ id: 'npm:test', status: 'success', value: await npmFetchMock() }],
  fetchRemoteUrlSourceResults: async () => [{ id: 'http:test', status: 'success', value: await remoteFetchMock() }],
  getLocalCache: Promise.resolve('done'),
  writeLocalCache: vi.fn(async () => {}),
}))
vi.mock('../../src/services/package-version', () => ({
  clearPackageVersionCache: vi.fn(),
  resolveInstalledPackageVersion: vi.fn(async () => '5.0.0'),
}))
vi.mock('../../src/type-extract/cache', () => ({ clearTypeCache: vi.fn() }))
vi.mock('../../src/constants', () => ({ UINames: ['antd'], nameMap: {} }))

describe('package context generations', () => {
  beforeEach(async () => {
    vi.resetModules()
    findUpMock.mockReset()
    fetchMock.mockReset()
    localFetchMock.mockReset().mockResolvedValue({})
    remoteFetchMock.mockReset().mockResolvedValue({})
    npmFetchMock.mockReset().mockResolvedValue({})
  })

  it('does not let a context started before global invalidation commit later', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    let resolveFetch!: (value: any) => void
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any

    const pending = mod.ensureContextForPath('/workspace/src/App.tsx', context, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    mod.invalidateContexts()
    resolveFetch({})

    await expect(pending).resolves.toBeUndefined()
    expect(mod.getContextForDocumentPath('/workspace/src/App.tsx')).toBeUndefined()
  })

  it('rejects every waiter joined to a globally invalidated context load', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    let resolveOld!: (value: any) => void
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({})
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/src/App.tsx'

    const first = mod.ensureContextForPath(documentPath, context, () => {})
    const joined = mod.ensureContextForPath(documentPath, context, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    mod.invalidateContexts()
    resolveOld({})

    await expect(first).resolves.toBeUndefined()
    await expect(joined).resolves.toBeUndefined()
    expect(mod.getContextForDocumentPath(documentPath)).toBeUndefined()

    await expect(mod.ensureContextForPath(documentPath, context, () => {})).resolves.toMatchObject({ pkgPath: '/workspace/package.json' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a package context invalidated while its first load is in flight', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    let resolveFirst!: (value: any) => void
    let resolveSecond!: (value: any) => void
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/src/App.tsx'

    const first = mod.ensureContextForPath(documentPath, context, () => {})
    const joined = mod.ensureContextForPath(documentPath, context, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    mod.invalidatePackageContext(documentPath)
    const second = mod.ensureContextForPath(documentPath, context, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    resolveFirst({})
    await expect(first).resolves.toBeUndefined()
    await expect(joined).resolves.toBeUndefined()
    expect(mod.getContextForDocumentPath(documentPath)).toBeUndefined()

    resolveSecond({})
    await expect(second).resolves.toMatchObject({ pkgPath: '/workspace/package.json' })
    expect(mod.getContextForDocumentPath(documentPath)?.pkgPath).toBe('/workspace/package.json')
  })

  it('notifies listeners when a package context is invalidated and rebuilt', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any
    const invalidated = vi.fn()
    const updated = vi.fn()
    const invalidationSubscription = mod.onPackageContextsInvalidated(invalidated)
    const updateSubscription = mod.onPackageContextUpdated(updated)

    await mod.ensureContextForPath('/workspace/src/App.tsx', context, () => {})
    mod.invalidatePackageContext('/workspace/src/App.tsx')

    expect(updated).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledWith(['/workspace/package.json'])
    invalidationSubscription.dispose()
    updateSubscription.dispose()
  })

  it('publishes official completions before a custom source resolves', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({
      antd5: () => ({ Button: { completions: [], events: [], methods: [], exposed: [], slots: [], suggestions: [] } }),
    })
    remoteFetchMock.mockReturnValue(new Promise(() => {}))
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any

    const result = await Promise.race([
      mod.ensureContextForPath('/workspace/src/App.tsx', context, () => {}, false, '/workspace'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('official baseline was blocked')), 100)),
    ]) as any

    expect(result?.uiCompletions?.Button).toBeDefined()
    expect(remoteFetchMock).toHaveBeenCalled()
  })

  it('publishes fast custom sources without waiting for a pending remote URL', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    remoteFetchMock.mockReturnValue(new Promise(() => {}))
    localFetchMock.mockResolvedValue({ LocalProps: () => ({ LocalButton: { source: 'local' } }) })
    npmFetchMock.mockResolvedValue({ NpmProps: () => ({ NpmButton: { source: 'npm' } }) })
    const mod = await import('../../src/ui/ui-find')
    const updated = vi.fn()
    mod.onPackageContextUpdated(updated)

    await mod.ensureContextForPath('/workspace/src/App.tsx', {} as any, () => {}, false, '/workspace')

    await vi.waitFor(() => {
      const contexts = updated.mock.calls.map(call => call[0])
      expect(contexts.some(value => value.uiCompletions?.LocalButton)).toBe(true)
      expect(contexts.some(value => value.uiCompletions?.NpmButton)).toBe(true)
    })
    expect(remoteFetchMock).toHaveBeenCalledTimes(1)
    const latestLocalContext = updated.mock.calls.map(call => call[0]).find(value => value.uiCompletions?.LocalButton)
    expect(mod.getSourceScope(latestLocalContext, 'local-props')).toMatchObject({ key: 'custom:local:test:LocalProps', lib: 'LocalProps' })
  })

  it('starts custom sources for a new package generation while the old generation is pending', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    let resolveOldRemote!: (value: any) => void
    remoteFetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveOldRemote = resolve }))
      .mockResolvedValueOnce({ Gen2Props: () => ({ Gen2Button: { source: 'gen2' } }) })
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'
    const extensionContext = { globalStorageUri: { fsPath: '/tmp' } } as any

    const first = await mod.ensureContextForPath(documentPath, extensionContext, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(remoteFetchMock).toHaveBeenCalledTimes(1))
    mod.invalidatePackageContext(documentPath)
    const second = await mod.ensureContextForPath(documentPath, extensionContext, () => {}, false, '/workspace')

    expect(second?.generation).toBeGreaterThan(first?.generation || 0)
    await vi.waitFor(() => expect(remoteFetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.Gen2Button).toBeDefined())

    resolveOldRemote({ OldProps: () => ({ OldButton: { source: 'gen1' } }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OldButton).toBeUndefined()
  })

  it('maps a custom manifest canonical package name to its completion scope', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    localFetchMock.mockResolvedValue({
      VendorProps: () => ({ VendorButton: { lib: '@vendor/ui', source: 'manifest' } }),
    })
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.VendorButton).toBeDefined())

    const context = mod.getContextForDocumentPath(documentPath)!
    expect(mod.getSourceScope(context, '@vendor/ui/button')).toMatchObject({ key: 'custom:local:test:VendorProps', exactLib: '@vendor/ui' })
  })

  it('keeps source-scoped caches when custom sources reuse an export key', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({ antd5: () => ({}) })
    const sourceA = { lib: '@a/ui', marker: 'a', methods: [{ name: 'a' }] }
    const sourceB = { lib: '@b/ui', marker: 'b', methods: [{ name: 'b' }] }
    localFetchMock.mockResolvedValue({ privateUi: () => ({ Button: sourceA }) })
    remoteFetchMock.mockResolvedValue({ privateUi: () => ({ Button: sourceB }) })
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(mod.getSourceScope(mod.getContextForDocumentPath(documentPath)!, '@b/ui')).toBeDefined())

    const context = mod.getContextForDocumentPath(documentPath)!
    const scopeA = mod.getSourceScope(context, '@a/ui')!
    const scopeB = mod.getSourceScope(context, '@b/ui')!
    expect(scopeA.key).toBe('custom:local:test:privateUi')
    expect(scopeB.key).toBe('custom:http:test:privateUi')
    expect(context.cacheMap.get(scopeA.key).Button).toBe(sourceA)
    expect(context.cacheMap.get(scopeB.key).Button).toBe(sourceB)
    expect(context.uiCompletions?.Button).toBe(sourceB)
  })

  it('removes metadata deleted by a successful custom-source refresh', async () => {
    let now = 3_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({ antd5: () => ({}) })
    localFetchMock
      .mockResolvedValueOnce({ CustomProps: () => ({ OldButton: { source: 'old' } }) })
      .mockResolvedValueOnce({ CustomProps: () => ({ NewButton: { source: 'new' } }) })
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OldButton).toBeDefined())
    now += 6 * 60 * 1000
    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')

    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.NewButton).toBeDefined())
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OldButton).toBeUndefined()
    nowSpy.mockRestore()
  })

  it('keeps the last-known-good source snapshot when refreshed exports fail reduction', async () => {
    let now = 3_250_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({ antd5: () => ({}) })
    localFetchMock
      .mockResolvedValueOnce({ CustomProps: () => ({ StableButton: { source: 'old' } }) })
      .mockResolvedValueOnce({ CustomProps: () => { throw new Error('broken reducer') } })
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.StableButton).toBeDefined())
    const checkedAt = mod.getContextForDocumentPath(documentPath)!.customSourcesCheckedAt
    now += 6 * 60 * 1000
    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')

    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.customFailureCount).toBe(1))
    const context = mod.getContextForDocumentPath(documentPath)!
    expect(context.uiCompletions?.StableButton).toMatchObject({ source: 'old' })
    expect(context.customSourcesCheckedAt).toBe(checkedAt)
    expect(context.customNextRetryAt).toBeGreaterThan(now)
    nowSpy.mockRestore()
  })

  it('replays the last successful custom snapshot onto a refreshed official baseline', async () => {
    let now = 3_500_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock
      .mockResolvedValueOnce({ antd5: () => ({ OfficialV1: { lib: 'antd' } }) })
      .mockResolvedValueOnce({ antd5: () => ({ OfficialV2: { lib: 'antd' } }) })
    localFetchMock
      .mockResolvedValueOnce({ CustomProps: () => ({ CustomButton: { source: 'custom' } }) })
      .mockReturnValueOnce(new Promise(() => {}))
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.CustomButton).toBeDefined())
    now += 11 * 60 * 1000
    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')

    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OfficialV2).toBeDefined())
    const refreshed = mod.getContextForDocumentPath(documentPath)
    expect(refreshed?.uiCompletions?.CustomButton).toBeDefined()
    expect(refreshed?.uiCompletions?.OfficialV1).toBeUndefined()
    nowSpy.mockRestore()
  })

  it('does not let an old custom reduction overwrite a newer official context', async () => {
    let now = 4_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock
      .mockResolvedValueOnce({ antd5: () => ({ OfficialV1: { lib: 'antd' } }) })
      .mockResolvedValueOnce({ antd5: () => ({ OfficialV2: { lib: 'antd' } }) })
    let resolveOld!: (value: any) => void
    localFetchMock
      .mockResolvedValueOnce({ SlowProps: () => new Promise((resolve) => { resolveOld = resolve }) })
      .mockResolvedValueOnce({})
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(localFetchMock).toHaveBeenCalledTimes(1))
    now += 11 * 60 * 1000
    await mod.ensureContextForPath(documentPath, {} as any, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OfficialV2).toBeDefined())

    resolveOld({ OldCustom: { source: 'stale' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OfficialV2).toBeDefined()
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OfficialV1).toBeUndefined()
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.OldCustom).toBeUndefined()
    nowSpy.mockRestore()
  })

  it('does not republish stale custom enhancement after global invalidation', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    let resolveRemote!: (value: any) => void
    remoteFetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveRemote = resolve }))
      .mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const extensionContext = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, extensionContext, () => {}, false, '/workspace')
    await vi.waitFor(() => expect(remoteFetchMock).toHaveBeenCalledTimes(1))
    mod.invalidateContexts()
    resolveRemote({ StaleProps: () => ({ stale: true }) })
    await new Promise(resolve => setTimeout(resolve, 0))

    await mod.ensureContextForPath(documentPath, extensionContext, () => {}, false, '/workspace')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a missing package root', async () => {
    findUpMock.mockResolvedValueOnce(undefined).mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/new-package/src/App.tsx'

    await expect(mod.ensureContextForPath(documentPath, context, () => {})).resolves.toBeUndefined()
    await expect(mod.ensureContextForPath(documentPath, context, () => {})).resolves.toMatchObject({ pkgPath: '/workspace/package.json' })
    expect(findUpMock).toHaveBeenCalledTimes(3)
  })

  it('refreshes a cached parent when a nearer package is created', async () => {
    findUpMock.mockImplementation(async () => '/workspace/package.json')
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/packages/new/src/App.tsx'

    const parent = await mod.ensureContextForPath(documentPath, context, () => {})
    findUpMock.mockImplementation(async () => '/workspace/packages/new/package.json')
    mod.invalidateDocumentPackageMappingsForManifest('/workspace/packages/new/package.json')
    const nested = await mod.ensureContextForPath(documentPath, context, () => {})

    expect(parent?.pkgPath).toBe('/workspace/package.json')
    expect(nested?.pkgPath).toBe('/workspace/packages/new/package.json')
  })

  it('reuses positive package discovery across repeated provider requests', async () => {
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/src/App.tsx'

    for (let index = 0; index < 100; index++)
      await mod.ensureContextForPath(documentPath, context, () => {})

    // One lookup resolves the document; findPkgUI performs one lookup while the
    // context is initially built. Subsequent provider calls perform neither.
    expect(findUpMock).toHaveBeenCalledTimes(2)
  })

  it('returns cached context and revalidates stale custom sources once in the background', async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({ antd5: () => ({}) })
    remoteFetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const extensionContext = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/src/App.tsx'

    const baseline = await mod.ensureContextForPath(documentPath, extensionContext, () => {})
    await vi.waitFor(() => expect(remoteFetchMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.customSourcesCheckedAt).toBe(now))
    now += 6 * 60 * 1000

    const existing = await mod.ensureContextForPath(documentPath, extensionContext, () => {})
    await mod.ensureContextForPath(documentPath, extensionContext, () => {})

    expect(existing?.generation).toBe(baseline?.generation)
    await vi.waitFor(() => expect(remoteFetchMock).toHaveBeenCalledTimes(2))
    nowSpy.mockRestore()
  })

  it('deduplicates stale official source revalidation while returning cached context', async () => {
    let now = 2_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const extensionContext = { globalStorageUri: { fsPath: '/tmp' } } as any
    const documentPath = '/workspace/src/App.tsx'

    const baseline = await mod.ensureContextForPath(documentPath, extensionContext, () => {})
    await vi.waitFor(() => expect(remoteFetchMock).toHaveBeenCalled())
    now += 11 * 60 * 1000
    const [first, second] = await Promise.all([
      mod.ensureContextForPath(documentPath, extensionContext, () => {}),
      mod.ensureContextForPath(documentPath, extensionContext, () => {}),
    ])

    expect(first).toBe(second)
    expect(first?.generation).toBe(baseline?.generation)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    nowSpy.mockRestore()
  })

  it('bounds inactive package contexts after documents close', async () => {
    findUpMock.mockImplementation(async (_name: string, options: any) => {
      const match = String(options.cwd).match(/\/workspace\/pkg-(\d+)/)
      return match ? `/workspace/pkg-${match[1]}/package.json` : '/workspace/package.json'
    })
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const extensionContext = { globalStorageUri: { fsPath: '/tmp' } } as any

    for (let index = 0; index < 25; index++) {
      const documentPath = `/workspace/pkg-${index}/src/App.tsx`
      await mod.ensureContextForPath(documentPath, extensionContext, () => {}, false, `/workspace/pkg-${index}`)
      mod.releaseDocumentContext(documentPath)
    }

    expect(mod.getContextRegistryStats()).toMatchObject({ contexts: 20, documents: 0 })
  })

  it('backs off an initial undefined official result and retries after 30 seconds', async () => {
    let now = 4_500_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ antd5: () => ({ Button: { lib: 'antd' } }) })
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    const initial = await mod.ensureContextForPath(documentPath, {} as any, () => {})
    expect(initial?.officialFailureCount).toBe(1)
    expect(initial?.officialCheckedAt).toBe(0)
    for (let index = 0; index < 100; index++)
      await mod.ensureContextForPath(documentPath, {} as any, () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 31_000
    await mod.ensureContextForPath(documentPath, {} as any, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.Button).toBeDefined())
    nowSpy.mockRestore()
  })

  it('retains last-known-good official metadata when a stale refresh fails', async () => {
    let now = 5_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    findUpMock.mockResolvedValue('/workspace/package.json')
    fetchMock
      .mockResolvedValueOnce({ antd5: () => ({ Button: { lib: 'antd' } }) })
      .mockRejectedValueOnce(new Error('registry offline'))
      .mockRejectedValueOnce(new Error('still offline'))
    const mod = await import('../../src/ui/ui-find')
    const documentPath = '/workspace/src/App.tsx'

    await mod.ensureContextForPath(documentPath, {} as any, () => {})
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.Button).toBeDefined()
    now += 11 * 60 * 1000
    await mod.ensureContextForPath(documentPath, {} as any, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mod.getContextForDocumentPath(documentPath)?.officialNextRetryAt).toBeGreaterThan(now))
    for (let index = 0; index < 100; index++)
      await mod.ensureContextForPath(documentPath, {} as any, () => {})
    expect(fetchMock).toHaveBeenCalledTimes(2)

    now += 31_000
    await mod.ensureContextForPath(documentPath, {} as any, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(mod.getContextForDocumentPath(documentPath)?.uiCompletions?.Button).toBeDefined()
    nowSpy.mockRestore()
  })

  it('discovers a nested package instead of reusing a loaded parent context', async () => {
    findUpMock.mockImplementation(async (_name: string, options: any) => options.cwd.includes('/nested/')
      ? '/workspace/nested/package.json'
      : '/workspace/package.json')
    fetchMock.mockResolvedValue({})
    const mod = await import('../../src/ui/ui-find')
    const context = { globalStorageUri: { fsPath: '/tmp' } } as any

    const parent = await mod.ensureContextForPath('/workspace/src/App.tsx', context, () => {})
    const nested = await mod.ensureContextForPath('/workspace/nested/src/App.tsx', context, () => {})

    expect(parent?.pkgPath).toBe('/workspace/package.json')
    expect(nested?.pkgPath).toBe('/workspace/nested/package.json')
  })
})
