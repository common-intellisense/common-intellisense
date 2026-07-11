import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveInstalledPackageVersion = vi.fn(async () => undefined)
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

vi.mock('../../src/services/package-version', async importOriginal => ({
  ...await importOriginal<any>(),
  resolveInstalledPackageVersion,
}))

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
    resolveInstalledPackageVersion.mockReset().mockResolvedValue(undefined)
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
    expect(mod.getSourceScope(context, 'my-ui')).toMatchObject({ key: 'antd5', lib: 'antd' })
    expect(mod.getSourceScope(context, 'antd')).toMatchObject({ key: 'antd5', lib: 'antd' })
  })

  it('uses the alias major rather than the unrelated wrapper package version', async () => {
    const mod = await import('../../src/ui/ui-find')
    await mod.updateCompletions([['@acme/ui', '1.4.0']] as any, {
      selectedUIs: [],
      alias: { '@acme/ui': 'elementUi2' },
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/repo/packages/a/package.json',
      workspaceRoot: '/repo',
    })

    expect(resolveInstalledPackageVersion).toHaveBeenCalledWith('element-ui', '/repo/packages/a')
    expect(fetchFromCommonIntellisense).toHaveBeenCalledWith(
      'element-ui2',
      expect.objectContaining({ pkgName: 'element-ui', uiName: 'elementUi2', installedVersion: undefined, adapterMajor: '2' }),
    )
  })

  it('treats a declared-major fallback as adapterMajor, not an exact installed version', async () => {
    const mod = await import('../../src/ui/ui-find')
    await mod.updateCompletions([['element-plus', '2']] as any, {
      selectedUIs: [],
      alias: {},
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/repo/packages/a/package.json',
      workspaceRoot: '/repo',
    })

    expect(fetchFromCommonIntellisense).toHaveBeenCalledWith(
      'element-plus2',
      expect.objectContaining({ pkgName: 'element-plus', installedVersion: undefined, adapterMajor: '2' }),
    )
  })

  it('records explicit source scopes for canonical built-in adapter keys', async () => {
    const mod = await import('../../src/ui/ui-find')
    const cases = [
      ['uview-ui', 'uview2'],
      ['@nextui-org/react', 'nextUi2'],
      ['@arco-design/web-react', 'arcoDesign2'],
      ['@nuxt/ui-pro', 'nuxtUiPro2'],
      ['@ark-ui/vue', 'arkVue2'],
      ['@dcloudio/uni-ui', 'dcloudioUniUi2'],
    ] as const
    const context = await mod.updateCompletions(cases.map(([source]) => [source, '2.0.0']) as any, {
      selectedUIs: [],
      alias: {},
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/repo/package.json',
      workspaceRoot: '/repo',
    })

    for (const [source, key] of cases)
      expect(mod.getSourceScope(context, source)?.key).toBe(key)
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

    await vi.waitFor(() => expect(fetchFromLocalUris).toHaveBeenCalledWith('/repo'))
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
