import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveInstalledPackageVersion = vi.fn(async () => undefined)
const fetchFromLocalUris = vi.fn(async (_root?: string) => ({}))
const writeLocalCache = vi.fn(async () => {})
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
  fetchLocalSourceResults: async (root?: string) => [{ id: 'local:test', status: 'success', value: await fetchFromLocalUris(root) }],
  fetchRemoteNpmSourceResults: vi.fn(async () => []),
  fetchRemoteUrlSourceResults: vi.fn(async () => []),
  getLocalCache: Promise.resolve('done'),
  localCacheUri: '/tmp/common-intellisense-mapping-test.json',
  writeLocalCache,
}))

describe('ui-find updateCompletions', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchFromCommonIntellisense.mockClear()
    fetchFromLocalUris.mockClear()
    writeLocalCache.mockReset().mockResolvedValue(undefined)
    resolveInstalledPackageVersion.mockReset().mockResolvedValue(undefined)
  })

  it('does not block the initial context on persistent cache writes', async () => {
    let release!: () => void
    writeLocalCache.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
    const mod = await import('../../src/ui/ui-find')

    const result = await Promise.race([
      mod.updateCompletions([], { selectedUIs: [], alias: {}, detectSlots: () => {}, prefix: {}, pkgPath: '/tmp/pkg.json' }),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100)),
    ])

    expect(result).not.toBe('blocked')
    release()
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
      selectedUIs: ['auto'],
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
      selectedUIs: ['auto'],
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
      selectedUIs: ['auto'],
      alias: {},
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/repo/package.json',
      workspaceRoot: '/repo',
    })

    for (const [source, key] of cases)
      expect(mod.getSourceScope(context, source)?.key).toBe(key)
  })

  it('keeps package roots broad for adapters with per-component dynamic libs', async () => {
    fetchFromCommonIntellisense.mockResolvedValueOnce({
      primevue4: () => ({
        Button: { lib: 'primevue/button' },
        InputText: { lib: 'primevue/inputtext' },
      } as any),
    })
    const mod = await import('../../src/ui/ui-find')
    const context = await mod.updateCompletions([['@private/ui', '1.0.0']] as any, {
      selectedUIs: ['auto'],
      alias: { '@private/ui': 'primevue4' },
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/repo/package.json',
      workspaceRoot: '/repo',
    })

    expect(mod.getSourceScope(context, 'primevue')).toMatchObject({ key: 'primevue4' })
    expect(mod.getSourceScope(context, '@private/ui')).toMatchObject({ key: 'primevue4' })
    expect(mod.getSourceScope(context, 'primevue/button')).toMatchObject({ key: 'primevue4', exactLib: 'primevue/button' })
    expect(mod.getSourceScope(context, '@private/ui/button')).toMatchObject({ key: 'primevue4', exactLib: 'primevue/button' })
    expect(mod.getSourceScope(context, 'primevue')?.acceptedLibs).toEqual(new Set(['primevue/button', 'primevue/inputtext']))
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

  it('keeps an explicitly empty selection disabled', async () => {
    const mod = await import('../../src/ui/ui-find')
    const context = await mod.updateCompletions([['antd', '5.0.0']] as any, {
      selectedUIs: [],
      alias: {},
      detectSlots: () => {},
      prefix: {},
      pkgPath: '/tmp/pkg.json',
    })
    expect(fetchFromCommonIntellisense).not.toHaveBeenCalled()
    expect(context.uiNames).toEqual([])
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

  it('marks a partial official load as failed while keeping successful metadata', async () => {
    fetchFromCommonIntellisense
      .mockImplementationOnce((async (_tag: string, options: any) => ({
        [options.uiName]: () => ({ GoodButton: { completions: [() => []], events: [() => []], methods: [], exposed: [], suggestions: [] } }),
      })) as any)
      .mockResolvedValueOnce(undefined as any)
    const mod = await import('../../src/ui/ui-find')

    const context = await mod.updateCompletions(
      [['antd', '5.0.0'], ['element-plus', '2.0.0']] as any,
      { selectedUIs: ['auto'], alias: {}, detectSlots: () => {}, prefix: {}, pkgPath: '/tmp/partial.json' },
    )

    expect(context.uiCompletions?.GoodButton).toBeDefined()
    expect(context.officialCheckedAt).toBe(0)
    expect(context.officialFailureCount).toBe(1)
    expect(context.officialNextRetryAt).toBeGreaterThan(0)
  })
  it('isolates official reducer failures while preserving healthy libraries', async () => {
    fetchFromCommonIntellisense
      .mockImplementationOnce((async (_tag: string, options: any) => ({
        [options.uiName]: () => ({ HealthyButton: { completions: [() => []], events: [() => []], methods: [], exposed: [], suggestions: [] } }),
      })) as any)
      .mockImplementationOnce((async (_tag: string, options: any) => ({
        [`${options.uiName}Components`]: () => { throw new Error('bad components') },
        [options.uiName]: async () => { throw new Error('bad props') },
      })) as any)
    const mod = await import('../../src/ui/ui-find')

    const context = await mod.updateCompletions(
      [['antd', '5.0.0'], ['element-plus', '2.0.0']] as any,
      { selectedUIs: ['auto'], alias: {}, detectSlots: () => {}, prefix: {}, pkgPath: '/tmp/reducer-error.json' },
    )

    expect(context.uiCompletions?.HealthyButton).toBeDefined()
    expect(context.officialCheckedAt).toBe(0)
    expect(context.officialFailureCount).toBe(1)
    expect(context.officialNextRetryAt).toBeGreaterThan(0)
  })
})
