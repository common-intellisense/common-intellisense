import { afterEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import { resolveLocalComponentModule } from '../src/parser'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'common-intellisense-local-'))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fsp.mkdir(outside, { recursive: true })
  return { workspace, outside, document: path.join(workspace, 'src', 'App.vue') }
}

describe('local component module boundaries', () => {
  it('allows workspace files but rejects traversal and symlink escapes', async () => {
    const { workspace, outside, document } = await fixture()
    const inside = path.join(workspace, 'src', 'Button.vue')
    const escaped = path.join(outside, 'Outside.vue')
    const link = path.join(workspace, 'src', 'Linked.vue')
    await fsp.writeFile(inside, '<template><button /></template>')
    await fsp.writeFile(escaped, '<template><button /></template>')
    await fsp.symlink(escaped, link)

    await expect(resolveLocalComponentModule('./Button', document, workspace)).resolves.toBe(await fsp.realpath(inside))
    await expect(resolveLocalComponentModule('../../outside/Outside.vue', document, workspace)).resolves.toBeUndefined()
    await expect(resolveLocalComponentModule(link, document, workspace)).resolves.toBeUndefined()
    await expect(resolveLocalComponentModule(`file://${escaped}`, document, workspace)).resolves.toBeUndefined()
  })

  it('rejects local component files larger than the parsing budget', async () => {
    const { workspace, document } = await fixture()
    const large = path.join(workspace, 'src', 'Large.tsx')
    await fsp.writeFile(large, Buffer.alloc(4 * 1024 * 1024 + 1))

    await expect(resolveLocalComponentModule(large, document, workspace)).resolves.toBeUndefined()
  })
})
