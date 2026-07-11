import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUpMock, fetchMock, remoteFetchMock } = vi.hoisted(() => ({
  findUpMock: vi.fn(),
  fetchMock: vi.fn(),
  remoteFetchMock: vi.fn(async () => ({})),
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
  fetchFromLocalUris: vi.fn(async () => ({})),
  fetchFromRemoteNpmUrls: vi.fn(async () => ({})),
  fetchFromRemoteUrls: remoteFetchMock,
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
    remoteFetchMock.mockReset().mockResolvedValue({})
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
