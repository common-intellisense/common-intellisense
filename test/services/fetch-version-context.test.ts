import { beforeEach, describe, expect, it, vi } from 'vitest'

const adapter = `module.exports = {
  fixture2: () => ({
    uiName: 'fixture2',
    lib: 'fixture-lib',
    map: [{
      name: 'Demo',
      props: {
        old: { type: 'string' },
        newer: { type: 'string', version: '2.6.0' }
      },
      events: []
    }]
  })
}`

vi.mock('@simon_he/fetch-npm', () => ({ fetchAndExtractPackage: vi.fn(async () => adapter) }))
vi.mock('@simon_he/fetch-npm-cjs', () => ({ fetchFromCjsForCommonIntellisense: vi.fn(async () => adapter) }))
vi.mock('@simon_he/latest-version', () => ({ latestVersion: vi.fn(async () => '1.0.0') }))
vi.mock('../../src/type-extract', () => ({ fetchFromTypes: vi.fn(async () => undefined) }))
vi.mock('../../src/ui/ui-find', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

describe('official adapter package version context', () => {
  beforeEach(() => vi.resetModules())

  it('injects installedVersion into object-shaped PropsOptions', async () => {
    const mod = await import('../../src/services/fetch')
    mod.clearFetchCaches()

    const [legacy, current] = await Promise.all([
      mod.fetchFromCommonIntellisense('fixture', {
        pkgName: 'fixture-lib',
        uiName: 'fixture2',
        resolveFrom: '/workspace/legacy/package.json',
        installedVersion: '2.4.0',
      }),
      mod.fetchFromCommonIntellisense('fixture', {
        pkgName: 'fixture-lib',
        uiName: 'fixture2',
        resolveFrom: '/workspace/current/package.json',
        installedVersion: '2.8.0',
      }),
    ])

    const vue = { languageId: 'vue', framework: 'vue' as const, uri: 'file:///Demo.vue' }
    const legacyProps = (await legacy!.fixture2()).Demo.completions[0](vue).map((item: any) => item.content)
    const currentProps = (await current!.fixture2()).Demo.completions[0](vue).map((item: any) => item.content)

    expect(legacyProps.some((content: string) => content.startsWith('newer'))).toBe(false)
    expect(currentProps.some((content: string) => content.startsWith('newer'))).toBe(true)
  })
})
