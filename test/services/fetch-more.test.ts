import vm from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let remoteUris: string[] = ['https://fake/remote.js']
let remoteNpmUris: ({ name: string, resource?: string } | string)[] = [{ name: '@common-intellisense/button', resource: undefined }]
let trustedHosts: string[] = ['fake']
let allowLegacyAdapters = true
const fetchFromTypesMock = vi.fn()

async function useMockRemoteRequester(mod: typeof import('../../src/services/fetch')) {
  const { ofetch } = await import('ofetch')
  mod.setRemoteTransportForTest(async (uri) => {
    let status = 200
    let location: string | undefined
    const body = await vi.mocked(ofetch)(uri, {
      onResponse({ response }: any) {
        status = response.status
        location = response.headers.get('location') || undefined
      },
    } as any)
    return { status, location, body: String(body ?? '') }
  }, async () => [{ address: '8.8.8.8', family: 4 }])
}

// This test file isolates different mocked behaviors from the other fetch.test.ts
vi.mock('node:fs', () => ({ existsSync: () => false }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => '{}') }))
vi.mock('@simon_he/fetch-npm', () => ({ fetchAndExtractPackage: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "X" }], ButtonProps: () => ({ bar: 2 }) }') }))
vi.mock('@simon_he/latest-version', () => ({ latestVersion: vi.fn(async () => '2.0.0') }))
vi.mock('@simon_he/fetch-npm-cjs', () => ({ fetchFromCjsForCommonIntellisense: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "X" }], ButtonProps: () => ({ bar: 2 }) }') }))
vi.mock('ofetch', () => ({ ofetch: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "X" }], ButtonProps: () => ({ bar: 2 }) }') }))
vi.mock('../../src/ui/utils', () => ({ componentsReducer: (v: any) => v, propsReducer: (v: any) => v?.map ?? v }))
vi.mock('../../src/type-extract', () => ({ fetchFromTypes: fetchFromTypesMock }))
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
    if (k === 'common-intellisense.allowLegacyAdapters')
      return allowLegacyAdapters
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
    trustedHosts = ['fake']
    allowLegacyAdapters = true
    fetchFromTypesMock.mockReset()
  })

  beforeEach(async () => {
    const mod = await import('../../src/services/fetch')
    await useMockRemoteRequester(mod)
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

  it('uses configured npm resources and isolates their cache keys', async () => {
    const fetchNpm = await import('@simon_he/fetch-npm')
    remoteNpmUris = [
      { name: '@common-intellisense/button', resource: 'dist/manifest.json' },
      { name: '@common-intellisense/button', resource: 'dist/alternate.json' },
    ]
    vi.mocked(fetchNpm.fetchAndExtractPackage)
      .mockResolvedValueOnce(JSON.stringify({ schemaVersion: 1, exports: { FirstProps: { uiName: 'first', lib: 'first', map: [] } } }))
      .mockResolvedValueOnce(JSON.stringify({ schemaVersion: 1, exports: { SecondProps: { uiName: 'second', lib: 'second', map: [] } } }))
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const result = await mod.fetchFromRemoteNpmUrls()

    expect(result.FirstProps).toBeTypeOf('function')
    expect(result.SecondProps).toBeTypeOf('function')
    expect(vi.mocked(fetchNpm.fetchAndExtractPackage)).toHaveBeenCalledWith(expect.objectContaining({ dist: 'dist/manifest.json' }))
    expect(vi.mocked(fetchNpm.fetchAndExtractPackage)).toHaveBeenCalledWith(expect.objectContaining({ dist: 'dist/alternate.json' }))
    expect(mod.cacheFetch.has('@common-intellisense/button@2.0.0::dist/manifest.json')).toBe(true)
    expect(mod.cacheFetch.has('@common-intellisense/button@2.0.0::dist/alternate.json')).toBe(true)
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

  it('isolates official adapter fallback results by package context', async () => {
    const fetchNpm = await import('@simon_he/fetch-npm')
    vi.mocked(fetchNpm.fetchAndExtractPackage).mockResolvedValue(`module.exports = {
      ButtonComponents: () => [{ name: "Button" }],
      ButtonProps: () => [{ name: "Button", props: { size: { type: "" } } }]
    }`)
    fetchFromTypesMock.mockImplementation(async ({ uiName, resolveFrom }: any) => ({
      [`${uiName}Raw`]: () => [{
        name: 'Button',
        props: { size: { type: resolveFrom.includes('/a/') ? 'AType' : 'BType' } },
      }],
    }))
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const [a, b] = await Promise.all([
      mod.fetchFromCommonIntellisense('button', { pkgName: 'button-a', uiName: 'buttonA', resolveFrom: '/workspace/a/package.json' }),
      mod.fetchFromCommonIntellisense('button', { pkgName: 'button-b', uiName: 'buttonB', resolveFrom: '/workspace/b/package.json' }),
    ])

    expect(a.ButtonProps()[0].props.size.type).toBe('AType')
    expect(b.ButtonProps()[0].props.size.type).toBe('BType')
    expect(fetchFromTypesMock).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale latest-version request delete or overwrite a newer request', async () => {
    const latest = await import('@simon_he/latest-version')
    let resolveOld!: (value: string) => void
    let resolveNew!: (value: string) => void
    vi.mocked(latest.latestVersion)
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveOld = resolve }))
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveNew = resolve }))
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const oldTask = mod.fetchFromCommonIntellisense('button')
    await Promise.resolve()
    mod.clearFetchCaches()
    const newTask = mod.fetchFromCommonIntellisense('button')
    await Promise.resolve()
    resolveNew('3.0.0')
    await newTask
    resolveOld('1.0.0')
    await oldTask

    await mod.fetchFromCommonIntellisense('button')
    expect(vi.mocked(latest.latestVersion)).toHaveBeenCalledTimes(2)
    expect(mod.cacheFetch.has('@common-intellisense/button@3.0.0')).toBe(true)
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

  it('backs off after a stale-cache refresh failure', async () => {
    const ofetchMod = await import('ofetch')
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.mocked(ofetchMod.ofetch).mockResolvedValue('module.exports = { ButtonProps: () => ({ value: 1 }) }')
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    expect((await mod.fetchFromRemoteUrls()).ButtonProps().value).toBe(1)
    nowSpy.mockReturnValue(1000 + 6 * 60 * 1000)
    vi.mocked(ofetchMod.ofetch).mockRejectedValue(new Error('offline'))
    expect((await mod.fetchFromRemoteUrls()).ButtonProps().value).toBe(1)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(2)

    expect((await mod.fetchFromRemoteUrls()).ButtonProps().value).toBe(1)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(2)

    nowSpy.mockReturnValue(1000 + 6 * 60 * 1000 + 31_000)
    vi.mocked(ofetchMod.ofetch).mockResolvedValue('module.exports = { ButtonProps: () => ({ value: 2 }) }')
    expect((await mod.fetchFromRemoteUrls()).ButtonProps().value).toBe(2)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(3)
    nowSpy.mockRestore()
  })

  it('blocks custom executable adapters unless legacy mode is explicitly enabled', async () => {
    allowLegacyAdapters = false
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockResolvedValue('module.exports = { ButtonProps: () => ({ unsafe: true }) }')
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const result = await mod.fetchFromRemoteUrls()
    expect(result).toEqual({})
  })

  it('loads data-only manifests while legacy mode is disabled', async () => {
    allowLegacyAdapters = false
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockResolvedValue(JSON.stringify({
      schemaVersion: 1,
      exports: {
        ButtonComponents: [{ name: 'ManifestButton' }],
        ButtonProps: { safe: true },
      },
    }))
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const result = await mod.fetchFromRemoteUrls()
    expect(result.ButtonComponents()[0].name).toBe('ManifestButton')
    expect(result.ButtonProps().safe).toBe(true)
  })

  it('rejects unknown manifest schema versions', async () => {
    allowLegacyAdapters = false
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockResolvedValue(JSON.stringify({ schemaVersion: 2, exports: { ButtonProps: {} } }))
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    await expect(mod.fetchFromRemoteUrls()).resolves.toEqual({})
  })

  it('shares a remote source task between concurrent callers', async () => {
    let resolveRemote!: (value: string) => void
    const pending = new Promise<string>((resolve) => { resolveRemote = resolve })
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockReturnValue(pending as any)
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const first = mod.fetchFromRemoteUrls()
    const second = mod.fetchFromRemoteUrls()
    expect(first).not.toBeUndefined()
    expect(second).not.toBeUndefined()
    resolveRemote('module.exports = { ButtonProps: () => ({ shared: true }) }')
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult?.ButtonProps().shared).toBe(true)
    expect(secondResult?.ButtonProps().shared).toBe(true)
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(1)
  })

  it('does not share in-flight results across different source configurations', async () => {
    let resolveFirst!: (value: string) => void
    const firstPending = new Promise<string>((resolve) => { resolveFirst = resolve })
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch)
      .mockReturnValueOnce(firstPending as any)
      .mockResolvedValueOnce('module.exports = { SecondProps: () => ({ source: "second" }) }')
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    remoteUris = ['https://fake/first.js']
    const first = mod.fetchFromRemoteUrls()
    remoteUris = ['https://fake/second.js']
    const second = mod.fetchFromRemoteUrls()
    resolveFirst('module.exports = { FirstProps: () => ({ source: "first" }) }')

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult?.FirstProps().source).toBe('first')
    expect(secondResult?.SecondProps().source).toBe('second')
    expect(vi.mocked(ofetchMod.ofetch)).toHaveBeenCalledTimes(2)
  })

  it('discards a source result completed after cache invalidation without executing it', async () => {
    let resolveRemote!: (value: string) => void
    const pending = new Promise<string>((resolve) => { resolveRemote = resolve })
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockReturnValue(pending as any)
    const executionSpy = vi.spyOn(vm.Script.prototype, 'runInContext')
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const resultPromise = mod.fetchFromRemoteUrls()
    mod.clearFetchCaches()
    resolveRemote('module.exports = { StaleProps: () => ({ stale: true }) }')

    await expect(resultPromise).resolves.toEqual({})
    expect(mod.cacheFetch.has('https://fake/remote.js')).toBe(false)
    expect(executionSpy).not.toHaveBeenCalled()
  })

  it('does not execute a stale cached remote fallback after invalidation', async () => {
    const ofetchMod = await import('ofetch')
    const executionSpy = vi.spyOn(vm.Script.prototype, 'runInContext')
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()
    mod.cacheFetch.set('https://fake/remote.js', 'module.exports = { StaleProps: () => ({ stale: true }) }')
    vi.mocked(ofetchMod.ofetch).mockImplementation(async () => {
      mod.clearFetchCaches()
      throw new Error('offline')
    })
    vi.spyOn(Date, 'now').mockReturnValue(6 * 60 * 1000)

    await expect(mod.fetchFromRemoteUrls()).resolves.toEqual({})
    expect(executionSpy).not.toHaveBeenCalled()
  })

  it('rejects an oversized legacy export before parsing its inner JSON', async () => {
    const ofetchMod = await import('ofetch')
    vi.mocked(ofetchMod.ofetch).mockResolvedValue(
      'module.exports = { HugeProps: () => ({ value: "x".repeat(9 * 1024 * 1024) }) }',
    )
    const parseSpy = vi.spyOn(JSON, 'parse')
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()
    parseSpy.mockClear()

    await expect(mod.fetchFromRemoteUrls()).resolves.toEqual({})
    // Manifest detection and the outer VM envelope may parse; the oversized inner JSON must not.
    expect(parseSpy.mock.calls.some(([value]) => (
      typeof value === 'string' && value.startsWith('{"value"') && value.length > 8 * 1024 * 1024
    ))).toBe(false)
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
