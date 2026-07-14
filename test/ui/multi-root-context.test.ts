import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchOfficial, watchFileMock } = vi.hoisted(() => ({
  fetchOfficial: vi.fn(async (_tag?: string, _options?: any) => ({})),
  watchFileMock: vi.fn(() => () => {}),
}))

vi.mock('find-up', () => ({
  findUp: vi.fn(async (_name: string, options: any) => options.cwd.startsWith('/workspace-b')
    ? '/workspace-b/packages/app/package.json'
    : options.cwd.includes('/packages/b/')
      ? '/workspace-a/packages/b/package.json'
      : '/workspace-a/packages/app/package.json'),
}))
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async (file: string) => {
      if (file === '/workspace-a/package.json')
        return JSON.stringify({ workspaces: ['packages/*'], dependencies: { antd: '^5.0.0' } })
      if (file === '/workspace-b/package.json')
        return JSON.stringify({ workspaces: ['packages/*'], dependencies: { 'element-plus': '^2.0.0' } })
      return JSON.stringify({ dependencies: {} })
    }),
    access: vi.fn(),
  },
}))
vi.mock('@vscode-use/utils', () => ({
  createLog: () => ({ info: vi.fn(), error: vi.fn() }),
  getCurrentFileUrl: vi.fn(),
  getLocale: () => 'en',
  getRootPath: () => '/workspace-a',
  getConfiguration: () => null,
  watchFile: watchFileMock,
}))
vi.mock('../../src/services/fetch', () => ({
  fetchFromCommonIntellisense: fetchOfficial,
  fetchLocalSourceResults: vi.fn(async () => []),
  fetchRemoteNpmSourceResults: vi.fn(async () => []),
  fetchRemoteUrlSourceResults: vi.fn(async () => []),
  getLocalCache: Promise.resolve('done'),
  writeLocalCache: vi.fn(async () => {}),
}))
vi.mock('../../src/services/package-version', () => ({
  clearPackageVersionCache: vi.fn(),
  resolveInstalledPackageVersion: vi.fn(async (name: string) => name === 'antd' ? '5.0.0' : '2.0.0'),
}))
vi.mock('../../src/type-extract/cache', () => ({ clearTypeCache: vi.fn() }))

describe('multi-root package contexts', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchOfficial.mockReset().mockResolvedValue({})
    watchFileMock.mockClear()
  })

  it('uses each document workspace root for root dependencies', async () => {
    const mod = await import('../../src/ui/ui-find')
    const extensionContext = {} as any
    const [a, b] = await Promise.all([
      mod.ensureContextForPath('/workspace-a/packages/app/src/App.tsx', extensionContext, () => {}, false, '/workspace-a'),
      mod.ensureContextForPath('/workspace-b/packages/app/src/App.tsx', extensionContext, () => {}, false, '/workspace-b'),
    ])

    expect(a?.workspaceRoot).toBe('/workspace-a')
    expect(b?.workspaceRoot).toBe('/workspace-b')
    expect(a?.uiNames).toEqual(['antd5'])
    expect(b?.uiNames).toEqual(['elementPlus2'])
  })

  it('keeps document contexts isolated when workspace A finishes after workspace B', async () => {
    let releaseA!: () => void
    const waitForA = new Promise<void>((resolve) => { releaseA = resolve })
    fetchOfficial.mockImplementation(async (_tag?: string, options?: any) => {
      if (options.uiName === 'antd5')
        await waitForA
      const componentName = options.uiName === 'antd5' ? 'AButton' : 'BButton'
      return {
        [options.uiName]: async () => ({ [componentName]: { name: componentName } }),
      }
    })
    const mod = await import('../../src/ui/ui-find')
    const extensionContext = {} as any
    const loadingA = mod.ensureContextForPath('/workspace-a/packages/app/src/App.tsx', extensionContext, () => {}, false, '/workspace-a')
    const contextB = await mod.ensureContextForPath('/workspace-b/packages/app/src/App.tsx', extensionContext, () => {}, false, '/workspace-b')
    releaseA()
    const contextA = await loadingA
    const currentB = await mod.ensureContextForPath('/workspace-b/packages/app/src/App.tsx', extensionContext, () => {}, false, '/workspace-b')

    expect(contextA?.uiCompletions).toHaveProperty('AButton')
    expect(contextA?.uiCompletions).not.toHaveProperty('BButton')
    expect(contextB?.uiCompletions).toHaveProperty('BButton')
    expect(currentB?.uiCompletions).toHaveProperty('BButton')
    expect(currentB?.uiCompletions).not.toHaveProperty('AButton')
  })
  it('recomputes monorepo state from true to false', async () => {
    const fs = await import('node:fs/promises')
    let rootHasWorkspaces = true
    vi.mocked(fs.default.readFile).mockImplementation(async (file: any) => {
      if (file === '/workspace-a/package.json')
        return JSON.stringify(rootHasWorkspaces ? { workspaces: ['packages/*'], dependencies: { antd: '^5.0.0' } } : { dependencies: { antd: '^5.0.0' } })
      return JSON.stringify({ dependencies: {} })
    })
    vi.mocked(fs.default.access).mockRejectedValue(new Error('no workspace file'))
    const mod = await import('../../src/ui/ui-find')

    const first = await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', undefined, '/workspace-a')
    rootHasWorkspaces = false
    const second = await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', undefined, '/workspace-a')

    expect(first?.uis).toEqual([['antd', '5.0.0']])
    expect(second?.uis).toEqual([])
  })

  it('invokes a child package watcher callback exactly once per change', async () => {
    const onChange = vi.fn()
    const mod = await import('../../src/ui/ui-find')

    await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', onChange, '/workspace-a')
    const packageWatch = (watchFileMock.mock.calls as any[][]).find(([file]) => file === '/workspace-a/packages/app/package.json')
    expect(packageWatch).toBeDefined()

    packageWatch![1].onChange()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('watches an existing non-monorepo root for a false-to-true transition', async () => {
    const fs = await import('node:fs/promises')
    let rootHasWorkspaces = false
    vi.mocked(fs.default.readFile).mockImplementation(async (file: any) => {
      if (file === '/workspace-a/package.json') {
        return JSON.stringify(rootHasWorkspaces
          ? { workspaces: ['packages/*'], dependencies: { antd: '^5.0.0' } }
          : { dependencies: { antd: '^5.0.0' } })
      }
      return JSON.stringify({ dependencies: {} })
    })
    vi.mocked(fs.default.access).mockRejectedValue(new Error('no workspace file'))
    const onChange = vi.fn()
    const mod = await import('../../src/ui/ui-find')

    const first = await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', onChange, '/workspace-a')
    expect(first?.uis).toEqual([])
    const rootWatch = (watchFileMock.mock.calls as any[][]).find(([file]) => file === '/workspace-a/package.json')
    expect(rootWatch).toBeDefined()

    rootHasWorkspaces = true
    rootWatch![1].onChange()
    expect(onChange).toHaveBeenCalled()
    const second = await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', onChange, '/workspace-a')
    expect(second?.uis).toEqual([['antd', '5.0.0']])
  })

  it('drops stale root dependencies when the root manifest disappears or is invalid', async () => {
    const fs = await import('node:fs/promises')
    let state: 'valid' | 'missing' | 'invalid' = 'valid'
    vi.mocked(fs.default.readFile).mockImplementation(async (file: any) => {
      if (file === '/workspace-a/package.json') {
        if (state === 'missing')
          throw new Error('ENOENT')
        if (state === 'invalid')
          return '{'
        return JSON.stringify({ workspaces: ['packages/*'], dependencies: { antd: '^5.0.0' } })
      }
      return JSON.stringify({ dependencies: {} })
    })
    vi.mocked(fs.default.access).mockRejectedValue(new Error('no workspace file'))
    const mod = await import('../../src/ui/ui-find')

    expect((await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', undefined, '/workspace-a'))?.uis).toEqual([['antd', '5.0.0']])
    state = 'missing'
    expect((await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', undefined, '/workspace-a'))?.uis).toEqual([])
    state = 'invalid'
    expect((await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', undefined, '/workspace-a'))?.uis).toEqual([])
    state = 'valid'
    expect((await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', undefined, '/workspace-a'))?.uis).toEqual([['antd', '5.0.0']])
  })

  it('notifies every loaded child package when the shared root manifest changes', async () => {
    const mod = await import('../../src/ui/ui-find')
    const rebuildA = vi.fn()
    const rebuildB = vi.fn()

    await mod.findPkgUI('/workspace-a/packages/app/src/App.tsx', rebuildA, '/workspace-a')
    await mod.findPkgUI('/workspace-a/packages/b/src/App.tsx', rebuildB, '/workspace-a')
    // Re-registering a child replaces, rather than duplicates, its subscriber.
    await mod.findPkgUI('/workspace-a/packages/app/src/Other.tsx', rebuildA, '/workspace-a')

    const rootWatch = (watchFileMock.mock.calls as any[]).find(([file]) => file === '/workspace-a/package.json')
    expect(rootWatch).toBeDefined()
    rootWatch[1].onChange()

    expect(rebuildA).toHaveBeenCalledTimes(1)
    expect(rebuildB).toHaveBeenCalledTimes(1)
  })

  it('does not inherit workspace-root dependencies without monorepo metadata', async () => {
    const fs = await import('node:fs/promises')
    vi.mocked(fs.default.readFile).mockImplementation(async (file: any) => {
      if (file === '/workspace-a/package.json')
        return JSON.stringify({ dependencies: { antd: '^5.0.0' } })
      return JSON.stringify({ dependencies: {} })
    })
    vi.mocked(fs.default.access).mockRejectedValue(new Error('no workspace file'))
    const mod = await import('../../src/ui/ui-find')

    const context = await mod.ensureContextForPath('/workspace-a/packages/app/src/App.tsx', {} as any, () => {}, false, '/workspace-a')

    expect(context?.uiNames).toEqual([])
  })
})
