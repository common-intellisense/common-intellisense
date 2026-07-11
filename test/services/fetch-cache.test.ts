import { describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    stat: statMock,
    readFile: readFileMock,
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
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

  it('settles when cached JSON is corrupted', async () => {
    vi.resetModules()
    statMock.mockResolvedValue({ size: 10 })
    readFileMock.mockResolvedValue('{broken json')
    const mod = await import('../../src/services/fetch')
    mod.configureCacheStorage('/tmp/cache')

    await expect(Promise.resolve(mod.getLocalCache)).resolves.toBe('done reading')
  })
})
