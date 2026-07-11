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
