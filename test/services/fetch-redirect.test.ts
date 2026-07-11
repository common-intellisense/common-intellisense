import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ofetch', () => ({ ofetch: vi.fn() }))
vi.mock('../../src/ui/utils', () => ({ componentsReducer: (v: any) => v, propsReducer: (v: any) => v }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

describe('remote redirect validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects redirects to loopback before issuing the second request', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementationOnce(async (_url: any, options: any) => {
      options.onResponse({ response: { status: 302, headers: { get: () => 'http://127.0.0.1/metadata' } } })
      return ''
    })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://public.example/adapter')).rejects.toThrow('untrusted URL')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(1)
  })

  it('rejects redirect hostnames that resolve to private addresses', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementationOnce(async (_url: any, options: any) => {
      options.onResponse({ response: { status: 302, headers: { get: () => 'https://internal.example/metadata' } } })
      return ''
    })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '169.254.169.254', family: 4 }])).rejects.toThrow('untrusted URL')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(1)
  })

  it('follows validated HTTPS redirects manually', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch)
      .mockImplementationOnce(async (_url: any, options: any) => {
        options.onResponse({ response: { status: 302, headers: { get: () => 'https://cdn.example/adapter' } } })
        return ''
      })
      .mockImplementationOnce(async (_url: any, options: any) => {
        options.onResponse({ response: { status: 200, headers: { get: () => null } } })
        return 'manifest'
      })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '8.8.8.8', family: 4 }])).resolves.toBe('manifest')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenNthCalledWith(2, 'https://cdn.example/adapter', expect.objectContaining({ redirect: 'manual' }))
  })

  it('stops redirect loops at the configured limit', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementation(async (_url: any, options: any) => {
      options.onResponse({ response: { status: 302, headers: { get: () => 'https://public.example/adapter' } } })
      return ''
    })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '8.8.8.8', family: 4 }])).rejects.toThrow('exceeded 5 redirects')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(6)
  })
})
