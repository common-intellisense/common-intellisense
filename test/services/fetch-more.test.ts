import { beforeEach, describe, expect, it, vi } from 'vitest'

let remoteUris: string[] = ['https://fake/remote.js']
let remoteNpmUris: ({ name: string, resource?: string } | string)[] = [{ name: '@common-intellisense/button', resource: undefined }]
let trustedHosts: string[] = []

// This test file isolates different mocked behaviors from the other fetch.test.ts
vi.mock('node:fs', () => ({ existsSync: () => false }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => '{}') }))
vi.mock('@simon_he/fetch-npm', () => ({ fetchAndExtractPackage: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "X" }], ButtonProps: () => ({ bar: 2 }) }') }))
vi.mock('@simon_he/latest-version', () => ({ latestVersion: vi.fn(async () => '2.0.0') }))
vi.mock('@simon_he/fetch-npm-cjs', () => ({ fetchFromCjsForCommonIntellisense: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "X" }], ButtonProps: () => ({ bar: 2 }) }') }))
vi.mock('ofetch', () => ({ ofetch: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "X" }], ButtonProps: () => ({ bar: 2 }) }') }))
vi.mock('../../src/ui/utils', () => ({ componentsReducer: (v: any) => v, propsReducer: (v: any) => v }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: () => {}, error: () => {} } }))
vi.mock('@vscode-use/utils', () => ({
  createFakeProgress: ({ callback }: any) => callback(() => {}, () => {}),
  getConfiguration: (k: string) => {
    if (k === 'common-intellisense.remoteUris')
      return remoteUris
    if (k === 'common-intellisense.localUris')
      return []
    if (k === 'common-intellisense.remoteNpmUris')
      return remoteNpmUris
    if (k === 'common-intellisense.trustedHosts')
      return trustedHosts
    return undefined
  },
  getLocale: () => 'en',
  getRootPath: () => require('node:process').cwd(),
  message: { error: () => {} },
  getConfigurationBy: () => undefined,
  createLog: (_name: string) => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

describe('fetch service additional tests (mocked)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    remoteUris = ['https://fake/remote.js']
    remoteNpmUris = [{ name: '@common-intellisense/button', resource: undefined }]
    trustedHosts = []
  })

  it('fetchFromCommonIntellisense returns parsed exports and caches the result', async () => {
    const mod = await import('../../src/services/fetch')
    if (mod.cacheFetch && typeof mod.cacheFetch.clear === 'function')
      mod.cacheFetch.clear()

    const res = await mod.fetchFromCommonIntellisense('Button')
    expect(res).toBeDefined()
    expect(typeof res.ButtonComponents).toBe('function')
    const comps = res.ButtonComponents()
    expect(Array.isArray(comps)).toBe(true)
    expect(comps[0].name).toBe('X')

    // version mocked to 2.0.0 and prefix in module is '@common-intellisense/'
    const key = '@common-intellisense/Button@2.0.0'
    expect(mod.cacheFetch.has(key)).toBe(true)
  })

  it('fetchFromRemoteNpmUrls handles configured npm packages', async () => {
    const mod = await import('../../src/services/fetch')
    if (mod.cacheFetch && typeof mod.cacheFetch.clear === 'function')
      mod.cacheFetch.clear()

    const res = await mod.fetchFromRemoteNpmUrls()
    expect(res).toBeDefined()
    // from mock the keys are ButtonComponents and ButtonProps
    expect(typeof res.ButtonComponents).toBe('function')
    expect(typeof res.ButtonProps).toBe('function')
    const comps = res.ButtonComponents()
    expect(comps[0].name).toBe('X')
    const props = res.ButtonProps()
    expect(props.bar).toBe(2)
  })

  it('fetchFromCommonIntellisense supports concurrent fetches for different keys', async () => {
    const fetchNpm = await import('@simon_he/fetch-npm')
    vi.mocked(fetchNpm.fetchAndExtractPackage).mockImplementation(async ({ name }: any) => {
      if (String(name).includes('/button'))
        return 'module.exports = { ButtonComponents: () => [{ name: "ButtonX" }], ButtonProps: () => ({ bar: 2 }) }'
      return 'module.exports = { InputComponents: () => [{ name: "InputY" }], InputProps: () => ({ baz: 3 }) }'
    })

    const mod = await import('../../src/services/fetch')
    mod.cacheFetch.clear()

    const [buttonRes, inputRes] = await Promise.all([
      mod.fetchFromCommonIntellisense('button'),
      mod.fetchFromCommonIntellisense('input'),
    ])

    expect(buttonRes).toBeDefined()
    expect(inputRes).toBeDefined()
    expect(typeof buttonRes.ButtonComponents).toBe('function')
    expect(typeof inputRes.InputComponents).toBe('function')
    expect(buttonRes.ButtonComponents()[0].name).toBe('ButtonX')
    expect(inputRes.InputComponents()[0].name).toBe('InputY')
  })

  it('fetchFromRemoteUrls does not block fetchFromRemoteNpmUrls', async () => {
    let resolveRemote!: (value: string) => void
    const pendingRemote = new Promise<string>((resolve) => {
      resolveRemote = resolve
    })
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockImplementation(async () => pendingRemote)

    const mod = await import('../../src/services/fetch')
    mod.cacheFetch.clear()

    const remoteTask = mod.fetchFromRemoteUrls()
    await Promise.resolve()
    const npmResult = await mod.fetchFromRemoteNpmUrls()

    expect(npmResult).toBeDefined()
    expect(typeof npmResult.ButtonComponents).toBe('function')

    resolveRemote('module.exports = { ButtonComponents: () => [{ name: "RemoteX" }], ButtonProps: () => ({ bar: 9 }) }')
    await remoteTask
  })

  it('fetchFromRemoteUrls caches by ttl and revalidates after ttl', async () => {
    const ofetchMod = await import('ofetch')
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1000)
    vi.mocked(ofetchMod.ofetch).mockResolvedValue('module.exports = { ButtonComponents: () => [{ name: "TTL" }], ButtonProps: () => ({ bar: 1 }) }')

    const mod = await import('../../src/services/fetch')
    mod.cacheFetch.clear()

    const first = await mod.fetchFromRemoteUrls()
    expect(first.ButtonProps().bar).toBe(1)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(1)

    const second = await mod.fetchFromRemoteUrls()
    expect(second.ButtonProps().bar).toBe(1)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(1000 + 6 * 60 * 1000)
    vi.mocked(ofetchMod.ofetch).mockResolvedValue('module.exports = { ButtonComponents: () => [{ name: "TTL2" }], ButtonProps: () => ({ bar: 2 }) }')

    const third = await mod.fetchFromRemoteUrls()
    expect(third.ButtonProps().bar).toBe(2)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })

  it('fetchFromRemoteUrls skips untrusted http hosts by default', async () => {
    remoteUris = ['http://example.com/unsafe.js']
    const ofetchMod = await import('ofetch')
    const mod = await import('../../src/services/fetch')
    mod.cacheFetch.clear()

    const res = await mod.fetchFromRemoteUrls()
    expect(res).toEqual({})
    expect(vi.mocked(ofetchMod.ofetch)).not.toHaveBeenCalled()
  })
})
