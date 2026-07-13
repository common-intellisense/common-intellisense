import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
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

async function mockedRequester(uri: string) {
  const { ofetch } = await import('ofetch')
  let status = 200
  let location: string | undefined
  const body = await vi.mocked(ofetch)(uri, {
    onResponse({ response }: any) {
      status = response.status
      location = response.headers.get('location') || undefined
    },
  } as any)
  return { status, location, body: String(body ?? '') }
}

describe('remote redirect validation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('allows an IPv6 loopback remote source', async () => {
    const { fetchRemoteText } = await import('../../src/services/fetch')
    const requester = vi.fn(async () => ({ status: 200, body: 'manifest' }))

    await expect(fetchRemoteText('http://[::1]/adapter', undefined, requester)).resolves.toBe('manifest')
    expect(requester).toHaveBeenCalledWith('http://[::1]/adapter', expect.objectContaining({ address: '::1', family: 6 }), expect.objectContaining({ kind: 'localhostHttp', hostname: '::1' }), expect.any(AbortSignal))
  })

  it('enforces an overall deadline even when an injected requester never settles', async () => {
    vi.useFakeTimers()
    try {
      const { fetchRemoteText } = await import('../../src/services/fetch')
      const requester = vi.fn(() => new Promise<any>(() => {}))
      const pending = fetchRemoteText('http://127.0.0.1/adapter', undefined, requester, 30_000)
      const assertion = expect(pending).rejects.toThrow('deadline exceeded')
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('allows only globally routable public addresses', async () => {
    const { isGloballyRoutableAddress } = await import('../../src/services/fetch')
    for (const address of ['127.0.0.1', '169.254.169.254', '192.0.0.1', '192.0.2.1', '::1', 'fe80::1', 'fec0::1', 'fc00::1', '64:ff9b:1::7f00:1', '64:ff9b::7f00:1', '2001:db8::1', '3fff::1'])
      expect(isGloballyRoutableAddress(address), address).toBe(false)
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isGloballyRoutableAddress(address), address).toBe(true)
  })

  it('rejects localhost DNS results outside the loopback range', async () => {
    const { fetchRemoteText, isLoopbackAddress } = await import('../../src/services/fetch')
    const requester = vi.fn(async () => ({ status: 200, body: 'manifest' }))

    expect(isLoopbackAddress('127.0.0.2')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('169.254.169.254')).toBe(false)
    await expect(fetchRemoteText('http://localhost/adapter', async () => [{ address: '169.254.169.254', family: 4 }], requester)).rejects.toThrow('non-loopback')
    expect(requester).not.toHaveBeenCalled()
  })

  it('pins the validated address into the actual request lookup', async () => {
    const server = createServer((_request, response) => response.end('manifest'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as any
    const { fetchRemoteText } = await import('../../src/services/fetch')
    const resolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }])
    try {
      await expect(fetchRemoteText(`http://localhost:${address.port}/adapter`, resolver)).resolves.toBe('manifest')
      expect(resolver).toHaveBeenCalledTimes(1)
    }
    finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('aborts streamed responses that exceed the byte limit', async () => {
    const server = createServer((_request, response) => {
      const chunk = Buffer.alloc(1024 * 1024)
      for (let index = 0; index < 9; index++)
        response.write(chunk)
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as any
    const { fetchRemoteText } = await import('../../src/services/fetch')
    try {
      await expect(fetchRemoteText(`http://localhost:${address.port}/adapter`, async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow('too large')
    }
    finally {
      server.close()
      await once(server, 'close')
    }
  })

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

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '8.8.8.8', family: 4 }], mockedRequester)).rejects.toThrow(/untrusted URL|not a trusted public target/)
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
    await expect(fetchRemoteText('https://public.example/adapter', resolveHost, mockedRequester)).rejects.toThrow(/untrusted URL|not a trusted public target/)
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

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '8.8.8.8', family: 4 }], mockedRequester)).resolves.toBe('manifest')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenNthCalledWith(2, 'https://cdn.example/adapter', expect.any(Object))
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

    await expect(fetchRemoteText(initial, async hostname => [{ address: hostname === 'localhost' ? '127.0.0.1' : '8.8.8.8', family: 4 }], mockedRequester)).resolves.toBe('manifest')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenNthCalledWith(2, redirected, expect.any(Object))
  })

  it.each([
    ['http://localhost:3000/adapter', 'http://localhost:2375/version', '127.0.0.1'],
    ['http://trusted.test:8443/adapter', 'http://trusted.test:9443/adapter', '8.8.8.8'],
  ])('rejects same-host redirects to another port: %s', async (initial, redirected, address) => {
    const { fetchRemoteText } = await import('../../src/services/fetch')
    const requester = vi.fn().mockResolvedValueOnce({ status: 302, location: redirected, body: '' })
    await expect(fetchRemoteText(initial, async () => [{ address, family: 4 }], requester)).rejects.toThrow('untrusted URL')
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('treats an explicit default HTTPS port as the same origin', async () => {
    const { fetchRemoteText } = await import('../../src/services/fetch')
    const requester = vi.fn()
      .mockResolvedValueOnce({ status: 302, location: 'https://trusted.test/next', body: '' })
      .mockResolvedValueOnce({ status: 200, body: 'manifest' })
    await expect(fetchRemoteText('https://trusted.test:443/adapter', async () => [{ address: '8.8.8.8', family: 4 }], requester)).resolves.toBe('manifest')
  })

  it('rejects a same-host HTTPS to HTTP downgrade', async () => {
    const { fetchRemoteText } = await import('../../src/services/fetch')
    const requester = vi.fn()
      .mockResolvedValueOnce({ status: 302, location: 'http://trusted.test/adapter', body: '' })

    await expect(fetchRemoteText('https://trusted.test/adapter', async () => [{ address: '8.8.8.8', family: 4 }], requester)).rejects.toThrow('untrusted URL')
    expect(requester).toHaveBeenCalledTimes(1)
  })

  it('stops redirect loops at the configured limit', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementation(async (_url: any, options: any) => {
      options.onResponse({ response: { status: 302, headers: { get: () => 'https://public.example/adapter' } } })
      return ''
    })
    const { fetchRemoteText } = await import('../../src/services/fetch')

    await expect(fetchRemoteText('https://public.example/adapter', async () => [{ address: '8.8.8.8', family: 4 }], mockedRequester)).rejects.toThrow('exceeded 5 redirects')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(6)
  })
})
