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

  it('does not restore an old read after caches are cleared', async () => {
    vi.resetModules()
    statMock.mockReset().mockResolvedValue({ size: 10 })
    readFileMock.mockReset()
    let releaseRead!: (value: string) => void
    readFileMock.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseRead = resolve }))
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/tmp/cache')

    const pending = Promise.resolve(mod.getLocalCache)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalled())
    mod.clearFetchCaches()
    releaseRead(JSON.stringify({ schemaVersion: 1, entries: [['old', 'payload']] }))
    await pending

    expect(mod.cacheFetch.has('old')).toBe(false)
  })

  it('does not restore a read from a previous cache location', async () => {
    vi.resetModules()
    statMock.mockReset().mockResolvedValue({ size: 10 })
    readFileMock.mockReset()
    let releaseRead!: (value: string) => void
    readFileMock.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseRead = resolve }))
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/tmp/old-cache')

    const pending = Promise.resolve(mod.getLocalCache)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalled())
    mod.configureCacheStorage('/tmp/new-cache')
    releaseRead(JSON.stringify({ schemaVersion: 1, entries: [['old-location', 'payload']] }))
    await pending

    expect(mod.cacheFetch.has('old-location')).toBe(false)
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

  it('serializes concurrent cache writes', async () => {
    vi.resetModules()
    let releaseFirst!: () => void
    writeFileMock.mockReset()
    renameMock.mockReset()
    writeFileMock
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce(undefined)
    renameMock.mockResolvedValue(undefined)
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/tmp/cache')
    mod.cacheFetch.set('first', 'one')

    const first = mod.writeLocalCache()
    await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(1))
    mod.cacheFetch.set('second', 'two')
    const second = mod.writeLocalCache()
    expect(writeFileMock).toHaveBeenCalledTimes(1)

    releaseFirst()
    await Promise.all([first, second])
    expect(writeFileMock).toHaveBeenCalledTimes(2)
    expect(renameMock).toHaveBeenCalledTimes(2)
    expect(writeFileMock.mock.calls[1][1]).toContain('["second","two"]')
  })

  it('bounds cache entries and keeps recently read values', async () => {
    vi.resetModules()
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()
    for (let index = 0; index < 100; index++)
      expect(mod.setFetchCacheEntry(`key-${index}`, `value-${index}`)).toBe(true)
    expect(mod.getFetchCacheEntry('key-0')).toBe('value-0')
    mod.setFetchCacheEntry('key-100', 'value-100')

    expect(mod.cacheFetch.size).toBe(100)
    expect(mod.cacheFetch.has('key-0')).toBe(true)
    expect(mod.cacheFetch.has('key-1')).toBe(false)
  })

  it('evicts by byte size and rejects oversized entries', async () => {
    vi.resetModules()
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()
    const sevenMb = 'x'.repeat(7 * 1024 * 1024)
    expect(mod.setFetchCacheEntry('first', sevenMb)).toBe(true)
    expect(mod.setFetchCacheEntry('second', sevenMb)).toBe(true)
    expect(mod.setFetchCacheEntry('third', 'y'.repeat(3 * 1024 * 1024))).toBe(true)

    expect(mod.cacheFetch.has('first')).toBe(false)
    expect(mod.getFetchCacheStats().bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(mod.setFetchCacheEntry('oversized', 'z'.repeat(8 * 1024 * 1024 + 1))).toBe(false)
    expect(mod.cacheFetch.has('oversized')).toBe(false)
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
