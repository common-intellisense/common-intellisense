import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock heavy dependencies before importing the module under test.
vi.mock('node:fs', () => ({ existsSync: () => false }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => '{}') }))
vi.mock('@simon_he/fetch-npm', () => ({ fetchAndExtractPackage: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "B" }], ButtonProps: () => ({ foo: 1 }) }') }))
vi.mock('@simon_he/latest-version', () => ({ latestVersion: vi.fn(async () => '1.0.0') }))
vi.mock('@simon_he/fetch-npm-cjs', () => ({ fetchFromCjsForCommonIntellisense: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "B" }], ButtonProps: () => ({ foo: 1 }) }') }))
vi.mock('ofetch', () => ({ ofetch: vi.fn(async () => 'module.exports = { ButtonComponents: (isZh) => [{ name: "B" }], ButtonProps: () => ({ foo: 1 }) }') }))
vi.mock('../../src/ui/utils', () => ({ componentsReducer: (v: any) => v, propsReducer: (v: any) => v }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: () => {}, error: () => {} } }))
vi.mock('@vscode-use/utils', () => ({
  createFakeProgress: ({ callback }: any) => callback(() => {}, () => {}),
  getConfiguration: (k: string) => {
    if (k === 'common-intellisense.remoteUris')
      return ['http://fake/remote.js']
    if (k === 'common-intellisense.localUris')
      return []
    if (k === 'common-intellisense.remoteNpmUris')
      return []
    return undefined
  },
  getLocale: () => 'en',
  getRootPath: () => require('node:process').cwd(),
  message: { error: () => {} },
  getConfigurationBy: () => undefined,
  createLog: (_name: string) => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

describe('fetch service (mocked)', () => {
  beforeEach(() => {
    // reset modules so mocks take effect on dynamic imports
    vi.resetModules()
  })

  it('fetchFromRemoteUrls parses script content returned by ofetch', async () => {
    const mod = await import('../../src/services/fetch')
    // ensure cache is clean
    if (mod.cacheFetch && typeof mod.cacheFetch.clear === 'function')
      mod.cacheFetch.clear()

    const res = await mod.fetchFromRemoteUrls()
    // should have keys from the scripted module
    expect(res).toBeDefined()
    // the service stores functions that when called return arrays/objects (we mocked reducers as identity)
    expect(typeof res.ButtonComponents).toBe('function')
    const comps = res.ButtonComponents()
    expect(Array.isArray(comps)).toBe(true)
    expect(comps[0].name).toBe('B')
    expect(typeof res.ButtonProps).toBe('function')
    const props = res.ButtonProps()
    expect(props.foo).toBe(1)
  })
})
