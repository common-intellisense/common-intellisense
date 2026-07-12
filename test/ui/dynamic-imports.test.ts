import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { resolveImportedComponent } from '../../src/index'
import { findDynamicComponent, getImportDeps } from '../../src/parser'
import { getUiDeps } from '../../src/ui/ui-utils'
import * as vsutils from '@vscode-use/utils'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures-dyn')
const fileA = path.join(fixturesDir, 'AsyncComp.vue')
const wrapperFile = path.join(fixturesDir, 'AppButton.vue')
const directoryWrapper = path.join(fixturesDir, 'DirectoryButton', 'index.vue')
const tsxWrapper = path.join(fixturesDir, 'TsxButton.tsx')
const svelteWrapper = path.join(fixturesDir, 'SvelteButton.svelte')

beforeAll(async () => {
  await fsp.mkdir(fixturesDir, { recursive: true })
  await fsp.writeFile(fileA, `<template><AsyncComp/></template><script>export default {}</script>`, 'utf8')
  await fsp.writeFile(wrapperFile, `<template><el-button /></template>`, 'utf8')
  await fsp.mkdir(path.dirname(directoryWrapper), { recursive: true })
  await fsp.writeFile(directoryWrapper, `<template><el-button /></template>`, 'utf8')
  await fsp.writeFile(tsxWrapper, `export default () => <ElButton />`, 'utf8')
  await fsp.writeFile(svelteWrapper, `<ElButton />`, 'utf8')
  // ensure getCurrentFileUrl resolves into the repo so relative imports point to test dir
  try {
    ;(vsutils as any).getCurrentFileUrl = () => path.join(process.cwd(), 'test', 'index.html')
  }
  catch {}
})

afterAll(async () => {
  try {
    await fsp.rm(fileA)
    await fsp.rm(wrapperFile)
    await fsp.rm(path.dirname(directoryWrapper), { recursive: true })
    await fsp.rm(tsxWrapper)
    await fsp.rm(svelteWrapper)
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

  it('keeps local wrapper imports on the one-level component resolution path', async () => {
    const code = `import AppButton from './fixtures-dyn/AppButton.vue'`
    const uiDeps = getUiDeps(code) || {}
    const localDeps = getImportDeps(code)
    const wrongButton = { lib: 'antd', marker: 'wrong-flattened-button' }
    const button = { lib: 'element-ui', marker: 'button' }

    await expect(resolveImportedComponent(
      'AppButton',
      uiDeps,
      { Button: wrongButton, ElButton: button } as any,
      new Map(),
      {},
      ['el'],
      new Map(),
      localDeps,
      path.join(process.cwd(), 'test', 'App.vue'),
    )).resolves.toMatchObject({ component: button, source: './fixtures-dyn/AppButton.vue' })

    const asyncCode = `const AppButton = defineAsyncComponent(() => import('./fixtures-dyn/AppButton.vue'))`
    await expect(resolveImportedComponent(
      'AppButton',
      getUiDeps(asyncCode) || {},
      { Button: wrongButton, ElButton: button } as any,
      new Map(),
      {},
      ['el'],
      new Map(),
      getImportDeps(asyncCode),
      path.join(process.cwd(), 'test', 'App.vue'),
    )).resolves.toMatchObject({ component: button, source: './fixtures-dyn/AppButton.vue' })

    const missing = await resolveImportedComponent(
      'Button',
      { Button: './fixtures-dyn/Missing.vue' },
      { Button: wrongButton, ElButton: button } as any,
      new Map(),
      {},
      ['el'],
      new Map(),
      { Button: './fixtures-dyn/Missing.vue' },
      path.join(process.cwd(), 'test', 'App.vue'),
    )
    expect(missing.source).toBe('./fixtures-dyn/Missing.vue')
    expect(missing.component).toBeUndefined()

    const missingAliasCode = `import { Foo as LocalFoo } from './fixtures-dyn/Missing.vue'`
    const missingAlias = await resolveImportedComponent(
      'LocalFoo',
      getUiDeps(missingAliasCode) || {},
      { Foo: { lib: 'other-ui', marker: 'wrong' } } as any,
      new Map(),
      {},
      [],
      new Map(),
      getImportDeps(missingAliasCode),
      path.join(process.cwd(), 'test', 'App.vue'),
    )
    expect(missingAlias.source).toBe('./fixtures-dyn/Missing.vue')
    expect(missingAlias.component).toBeUndefined()

    await expect(resolveImportedComponent(
      'Button',
      { Button: '@/fixtures-dyn/AppButton.vue' },
      { Button: wrongButton, ElButton: button } as any,
      new Map(),
      {},
      ['el'],
      new Map(),
      { Button: '@/fixtures-dyn/AppButton.vue' },
      '/wrong-workspace/src/App.vue',
      path.join(process.cwd(), 'test'),
    )).resolves.toMatchObject({ component: button, source: '@/fixtures-dyn/AppButton.vue' })

    for (const source of ['./fixtures-dyn/AppButton', './fixtures-dyn/AppButton.vue?component', './fixtures-dyn/DirectoryButton', './fixtures-dyn/TsxButton', './fixtures-dyn/SvelteButton']) {
      await expect(resolveImportedComponent(
        'Button',
        { Button: source },
        { Button: wrongButton, ElButton: button } as any,
        new Map(),
        {},
        ['el'],
        new Map(),
        { Button: source },
        path.join(process.cwd(), 'test', 'App.vue'),
      )).resolves.toMatchObject({ component: button, source })
    }
  })
})
