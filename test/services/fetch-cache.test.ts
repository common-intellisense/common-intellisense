import { describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock, writeFileMock, renameMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  renameMock: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    stat: statMock,
    readFile: readFileMock,
    mkdir: vi.fn(),
    writeFile: writeFileMock,
    rename: renameMock,
    rm: vi.fn(async () => {}),
    realpath: vi.fn(async (value: string) => value),
  },
}))
vi.mock('../../src/ui/utils', () => ({ componentsReducer: (value: any) => value, propsReducer: (value: any) => value }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

describe('persistent fetch cache', () => {
  it('settles when an existing cache cannot be read', async () => {
    statMock.mockResolvedValue({ size: 10 })
    readFileMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/protected/cache')

    await expect(Promise.resolve(mod.getLocalCache)).resolves.toBe('done reading')
  })

  it('does not rename an old write after caches are cleared', async () => {
    vi.resetModules()
    let releaseWrite!: () => void
    writeFileMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseWrite = resolve }))
    renameMock.mockClear()
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/tmp/cache')
    mod.cacheFetch.set('old', 'payload')

    const pending = mod.writeLocalCache()
    await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalled())
    mod.clearFetchCaches()
    releaseWrite()
    await pending

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('settles when cached JSON is corrupted', async () => {
    vi.resetModules()
    statMock.mockResolvedValue({ size: 10 })
    readFileMock.mockResolvedValue('{broken json')
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/tmp/cache')

    await expect(Promise.resolve(mod.getLocalCache)).resolves.toBe('done reading')
  })
})
