import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchFromLocalUris = vi.fn(async () => ({}))
const fetchFromCommonIntellisense = vi.fn(async (_tag: string, options: any) => {
  const uiName = options.uiName
  return {
    [`${uiName}Components`]: () => [{
      prefix: uiName,
      data: () => [],
      directives: {},
      lib: uiName,
    }],
    [uiName]: () => ({
      [`${uiName}Button`]: { completions: [() => []], events: [() => []], methods: [], exposed: [], suggestions: [] },
    }),
  }
})

vi.mock('../../src/services/fetch', () => ({
  cacheFetch: new Map(),
  fetchFromCommonIntellisense,
  fetchFromLocalUris,
  fetchFromRemoteNpmUrls: vi.fn(async () => ({})),
  fetchFromRemoteUrls: vi.fn(async () => ({})),
  getLocalCache: Promise.resolve('done'),
  localCacheUri: '/tmp/common-intellisense-mapping-test.json',
  writeLocalCache: vi.fn(async () => {}),
}))

describe('ui-find updateCompletions', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchFromCommonIntellisense.mockClear()
    fetchFromLocalUris.mockClear()
  })

  it('selects only the aliased adapter when selectedUIs uses the origin name', async () => {
    const mod = await import('../../src/ui/ui-find')

    const context = await mod.updateCompletions(
      [['my-ui', '2.1.0'], ['element-plus', '2.9.0']] as any,
      {
        selectedUIs: ['my-ui5'],
        alias: { 'my-ui': 'antd5' },
        detectSlots: () => {},
        prefix: {},
        pkgPath: '/tmp/pkg.json',
      },
    )

    expect(fetchFromCommonIntellisense).toHaveBeenCalledTimes(1)
    expect(fetchFromCommonIntellisense).toHaveBeenCalledWith(
      'antd5',
      expect.objectContaining({
        pkgName: 'antd',
        uiName: 'antd5',
      }),
    )
    expect(context.uiNames).toEqual(['antd5'])
  })

  it('uses the workspace root rather than the nested package root for local adapters', async () => {
    const mod = await import('../../src/ui/ui-find')
    await mod.updateCompletions([], {
      selectedUIs: [],
      alias: {},
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/repo/packages/a/package.json',
      workspaceRoot: '/repo',
    })

    expect(fetchFromLocalUris).toHaveBeenCalledWith('/repo')
  })

  it('keeps an unmatched explicit selection empty instead of loading every detected UI', async () => {
    const mod = await import('../../src/ui/ui-find')
    const context = await mod.updateCompletions(
      [['antd', '5.0.0'], ['element-plus', '2.9.0']] as any,
      {
        selectedUIs: ['unknown-ui'],
        alias: {},
        detectSlots: () => {},
        prefix: {},
        pkgPath: '/tmp/pkg.json',
      },
    )

    expect(fetchFromCommonIntellisense).not.toHaveBeenCalled()
    expect(context.uiNames).toEqual([])
  })
})
