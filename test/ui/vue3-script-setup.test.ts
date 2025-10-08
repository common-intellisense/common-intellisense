import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findDynamicComponent, getImportDeps } from '../../src/parser'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures-vue3')
const fixtureFile = path.join(fixturesDir, 'Pagination.vue')

beforeAll(async () => {
  await fsp.mkdir(fixturesDir, { recursive: true })
  const content = `
<template>
  <div />
</template>
<script>
export default {}
</script>
`
  await fsp.writeFile(fixtureFile, content, 'utf8')
})

afterAll(async () => {
  try {
    await fsp.rm(fixtureFile)
    await fsp.rmdir(fixturesDir)
  }
  catch {}
})

describe('vue3 <script setup> mapping', () => {
  it('maps imported components in script setup for template usage', async () => {
    const sfc = `
<script setup>
import Pagination from './fixtures/Pagination.vue'
</script>
<template>
  <Pagination />
</template>
`

    const deps = getImportDeps(sfc)
    expect(deps.Pagination).toBe('./fixtures/Pagination.vue')

    const target = {
      completions: [() => []],
      events: [() => []],
      methods: [],
      exposed: [],
      slots: [],
      suggestions: [],
      tableDocument: null,
      uiName: 'my-pagination',
      lib: 'test',
    }
    const UiCompletions: any = { Pagination: target }

    const found = await findDynamicComponent('Pagination', deps, UiCompletions, [])
    expect(found).toBe(target)
  })
})
