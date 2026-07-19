import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveLocalAdapterFile, resolveLocalAdapterPath } from '../../src/services/fetch'

describe('local adapter workspace boundary', () => {
  it('resolves a workspace-root manifest from a nested package context', () => {
    const root = path.resolve('/repo')
    expect(resolveLocalAdapterPath(root, './common-intellisense.json')).toBe(path.join(root, 'common-intellisense.json'))
  })

  it('rejects paths outside the workspace root', () => {
    expect(resolveLocalAdapterPath(path.resolve('/repo'), '../outside.json')).toBeUndefined()
  })

  it('shares file, missing-file, directory, and symlink boundaries with watchers', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-local-path-'))
    const root = path.join(base, 'workspace')
    const outside = path.join(base, 'outside.json')
    await fsp.mkdir(root)
    const outsideDirectory = path.join(base, 'outside-directory')
    await fsp.mkdir(outsideDirectory)
    await fsp.writeFile(outside, '{}')
    await fsp.writeFile(path.join(outsideDirectory, 'manifest.json'), '{}')
    await fsp.writeFile(path.join(root, 'inside.json'), '{}')
    await fsp.symlink(outside, path.join(root, 'escape.json'))
    await fsp.symlink(outsideDirectory, path.join(root, 'escape-directory'))
    await fsp.symlink(path.join(base, 'missing.json'), path.join(root, 'broken.json'))
    expect(await resolveLocalAdapterFile(root, './inside.json')).toBe(await fsp.realpath(path.join(root, 'inside.json')))
    expect(await resolveLocalAdapterFile(root, './missing.json', { allowMissing: true })).toBe(path.join(root, 'missing.json'))
    expect(await resolveLocalAdapterFile(root, '.')).toBeUndefined()
    expect(await resolveLocalAdapterFile(root, '../outside.json')).toBeUndefined()
    expect(await resolveLocalAdapterFile(root, './escape.json')).toBeUndefined()
    expect(await resolveLocalAdapterFile(root, './escape-directory/manifest.json')).toBeUndefined()
    expect(await resolveLocalAdapterFile(root, './broken.json')).toBeUndefined()
    expect(await resolveLocalAdapterFile(path.join(base, 'missing-workspace'), './manifest.json')).toBeUndefined()
    await fsp.rm(base, { recursive: true, force: true })
  })
})
