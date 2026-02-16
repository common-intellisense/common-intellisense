import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchFromCommonIntellisense = vi.fn(async () => ({
  antd5Components: () => [{
    prefix: 'a',
    data: () => [],
    directives: {},
    lib: 'antd5',
  }],
  antd5: () => ({ Button: { completions: [() => []], events: [() => []], methods: [], exposed: [], suggestions: [] } }),
}))

vi.mock('../../src/services/fetch', () => ({
  cacheFetch: new Map(),
  fetchFromCommonIntellisense,
  fetchFromLocalUris: vi.fn(async () => ({})),
  fetchFromRemoteNpmUrls: vi.fn(async () => ({})),
  fetchFromRemoteUrls: vi.fn(async () => ({})),
  getLocalCache: Promise.resolve('done'),
  localCacheUri: '/tmp/common-intellisense-mapping-test.json',
}))

describe('ui-find updateCompletions', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchFromCommonIntellisense.mockClear()
  })

  it('keeps aliased ui when selectedUIs includes the origin name', async () => {
    const mod = await import('../../src/ui/ui-find')

    await mod.updateCompletions(
      [['my-ui', '2.1.0']] as any,
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
  })
})
