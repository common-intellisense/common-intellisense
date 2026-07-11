import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUpMock, fetchMock } = vi.hoisted(() => ({
  findUpMock: vi.fn(),
  fetchMock: vi.fn(),
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
  fetchFromRemoteUrls: vi.fn(async () => ({})),
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    mod.invalidatePackageContext(documentPath)
    const second = mod.ensureContextForPath(documentPath, context, () => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    resolveFirst({})
    await expect(first).resolves.toBeUndefined()
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
