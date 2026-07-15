import { describe, expect, it, vi } from 'vitest'

const resolveVersion = vi.hoisted(() => vi.fn(async () => '5.0.0'))

vi.mock('find-up', () => ({ findUp: vi.fn(async () => '/repo/packages/a/package.json') }))
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async (file: string) => file === '/repo/packages/a/package.json'
      ? JSON.stringify({ dependencies: { '@acme/ui': '^5.0.0' } })
      : JSON.stringify({ workspaces: ['packages/*'] })),
    access: vi.fn(),
  },
}))
vi.mock('@vscode-use/utils', () => ({
  createLog: () => ({ info: vi.fn(), error: vi.fn() }),
  getCurrentFileUrl: vi.fn(),
  getLocale: () => 'en',
  getRootPath: () => '/repo',
  getConfiguration: (key: string) => key === 'common-intellisense.alias'
    ? { '${workspaceFolder}/packages/a/package.json': { '@acme/ui': 'antd5' } }
    : null,
  watchFile: () => () => {},
}))
vi.mock('../../src/services/package-version', () => ({
  clearPackageVersionCache: vi.fn(),
  resolveInstalledPackageVersion: resolveVersion,
}))

describe('package-scoped alias discovery', () => {
  it('detects a non-built-in dependency through the package alias map', async () => {
    const { findPkgUI } = await import('../../src/ui/ui-find')
    const result = await findPkgUI('/repo/packages/a/src/App.vue', undefined, '/repo')

    expect(result?.uis).toEqual([['@acme/ui', '5.0.0']])
    expect(resolveVersion).toHaveBeenCalledWith('@acme/ui', '/repo/packages/a')
  })
})
