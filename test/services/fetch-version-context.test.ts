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
  }),
  fixture2Components: () => ({
    lib: 'fixture-lib',
    directives: [
      { name: 'old', description: '', description_zh: '', link: '', link_zh: '' },
      { name: 'newer', version: '2.6.0', description: '', description_zh: '', link: '', link_zh: '' }
    ],
    map: [
      [{ name: 'Old' }, 'Old'],
      [{ name: 'Newer', version: '2.6.0' }, 'Newer']
    ]
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

    const legacyComponents = legacy!.fixture2Components()
    const currentComponents = current!.fixture2Components()
    const legacyTags = (await Promise.all(legacyComponents[0].data(undefined, vue))).map((item: any) => item.content.split('  ')[0])
    const currentTags = (await Promise.all(currentComponents[0].data(undefined, vue))).map((item: any) => item.content.split('  ')[0])
    expect(legacyTags).toEqual(['old'])
    expect(currentTags).toEqual(['old', 'newer'])
    expect(legacyComponents[0].directives.map((item: any) => item.name)).toEqual(['old'])
    expect(currentComponents[0].directives.map((item: any) => item.name)).toEqual(['old', 'newer'])
  })
})
