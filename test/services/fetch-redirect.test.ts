import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ofetch', () => ({ ofetch: vi.fn() }))
vi.mock('@vscode-use/utils', () => ({
  createFakeProgress: ({ callback }: any) => callback(() => {}, () => {}),
  getConfiguration: (key: string) => key === 'common-intellisense.trustedHosts' ? ['trusted.test'] : null,
  getLocale: () => 'en',
  getRootPath: () => '',
  message: { error: vi.fn() },
}))
vi.mock('../../src/ui/utils', () => ({ componentsReducer: (v: any) => v, propsReducer: (v: any) => v }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

describe('remote redirect validation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('rejects a private initial HTTPS target before issuing a request', async () => {
    const ofetchMod = await import('ofetch')
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://169.254.169.254/metadata')).rejects.toThrow('not a trusted public target')
    expect(vi.mocked(ofetchMod.ofetch)).not.toHaveBeenCalled()
  })

  it('rejects an initial hostname resolving to a private address before issuing a request', async () => {
    const ofetchMod = await import('ofetch')
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://internal.example/adapter', async () => [{ address: '169.254.169.254', family: 4 }])).rejects.toThrow('not a trusted public target')
    expect(vi.mocked(ofetchMod.ofetch)).not.toHaveBeenCalled()
  })

  it('rejects redirects to loopback before issuing the second request', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementationOnce(async (_url: any, options: any) => {
      options.onResponse({ response: { status: 302, headers: { get: () => 'http://127.0.0.1/metadata' } } })
      return ''
    })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '8.8.8.8', family: 4 }])).rejects.toThrow('untrusted URL')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(1)
  })

  it('rejects redirect hostnames that resolve to private addresses', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementationOnce(async (_url: any, options: any) => {
      options.onResponse({ response: { status: 302, headers: { get: () => 'https://internal.example/metadata' } } })
      return ''
    })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    const resolveHost = vi.fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    await expect(fetchRemoteText('https://public.example/adapter', resolveHost)).rejects.toThrow('untrusted URL')
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

  it.each([
    ['http://localhost/adapter', 'http://localhost/adapter.json'],
    ['http://trusted.test/adapter', 'http://trusted.test/adapter.json'],
  ])('allows redirects within the initial trusted host: %s', async (initial, redirected) => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch)
      .mockImplementationOnce(async (_url: any, options: any) => {
        options.onResponse({ response: { status: 302, headers: { get: () => redirected } } })
        return ''
      })
      .mockImplementationOnce(async (_url: any, options: any) => {
        options.onResponse({ response: { status: 200, headers: { get: () => null } } })
        return 'manifest'
      })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText(initial)).resolves.toBe('manifest')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenNthCalledWith(2, redirected, expect.objectContaining({ redirect: 'manual' }))
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
