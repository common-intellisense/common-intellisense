import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchOfficial = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock('find-up', () => ({
  findUp: vi.fn(async (_name: string, options: any) => options.cwd.startsWith('/workspace-b')
    ? '/workspace-b/packages/app/package.json'
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
  watchFile: () => () => {},
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
  beforeEach(() => vi.resetModules())

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
