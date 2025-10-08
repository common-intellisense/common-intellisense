import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      return []
    if (k === 'common-intellisense.localUris')
      return []
    if (k === 'common-intellisense.remoteNpmUris')
      return [{ name: '@common-intellisense/button', resource: undefined }]
    return undefined
  },
  getLocale: () => 'en',
  getRootPath: () => process.cwd(),
  message: { error: () => {} },
  getConfigurationBy: () => undefined,
}))

describe('fetch service additional tests (mocked)', () => {
  beforeEach(() => {
    vi.resetModules()
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
})
