import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findDynamicComponent, getImportDeps } from '../../src/parser'
import * as vsutils from '@vscode-use/utils'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures-dyn')
const fileA = path.join(fixturesDir, 'AsyncComp.vue')

beforeAll(async () => {
  await fsp.mkdir(fixturesDir, { recursive: true })
  await fsp.writeFile(fileA, `<template><AsyncComp/></template><script>export default {}</script>`, 'utf8')
  // ensure getCurrentFileUrl resolves into the repo so relative imports point to test dir
  try {
    ;(vsutils as any).getCurrentFileUrl = () => path.join(process.cwd(), 'test', 'index.html')
  }
  catch {}
})

afterAll(async () => {
  try {
    await fsp.rm(fileA)
    await fsp.rmdir(fixturesDir)
  }
  catch {}
})

describe('dynamic import and defineAsyncComponent', () => {
  it('detects import(...) and defineAsyncComponent patterns', async () => {
    const code = `
import { defineAsyncComponent } from 'vue'
const Async1 = import('./fixtures-dyn/AsyncComp.vue')
const Async2 = defineAsyncComponent(() => import('./fixtures-dyn/AsyncComp.vue'))

export default {}
`

    const deps = getImportDeps(code)
    expect(deps.Async1).toBe('./fixtures-dyn/AsyncComp.vue')
    expect(deps.Async2).toBe('./fixtures-dyn/AsyncComp.vue')

    const UiCompletions: any = { AsyncComp: { uiName: 'async-comp' } }
    const found1 = await findDynamicComponent('Async1', deps, UiCompletions, [])
    const found2 = await findDynamicComponent('Async2', deps, UiCompletions, [])
    expect(found1).toBe(UiCompletions.AsyncComp)
    expect(found2).toBe(UiCompletions.AsyncComp)
  })
})
