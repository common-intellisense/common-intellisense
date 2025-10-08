import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findDynamicComponent, getImportDeps } from '../../src/parser'
import * as vsutils from '@vscode-use/utils'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures')
const fixtureFile = path.join(fixturesDir, 'Pagination.vue')

beforeAll(async () => {
  await fsp.mkdir(fixturesDir, { recursive: true })
  const content = `
<template>
  <MyPagination />
</template>
<script>
export default {}
</script>
`
  await fsp.writeFile(fixtureFile, content, 'utf8')
  // ensure getCurrentFileUrl resolves into the repo so relative imports point to test dir
  try {
    ;(vsutils as any).getCurrentFileUrl = () => path.join(process.cwd(), 'test', 'index.html')
  }
  catch {}
})

afterAll(async () => {
  try {
    await fsp.rm(fixtureFile)
    await fsp.rmdir(fixturesDir)
  }
  catch {}
})

describe('vue2 end-to-end mapping', () => {
  it('resolves template tag via components map and fixture file', async () => {
    const sfc = `
<script>
import Pagination from './fixtures/Pagination.vue'

export default {
  components: {
    heihei: Pagination,
  }
}
</script>
<template>
  <heihei />
</template>
`

    const deps = getImportDeps(sfc)
    // ensure our mapping exists
    expect(deps.heihei).toBe('./fixtures/Pagination.vue')

    // prepare UiCompletions where the tag found in fixture is MyPagination
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
    const UiCompletions: any = { MyPagination: target }

    const found = await findDynamicComponent('heihei', deps, UiCompletions, [])
    expect(found).toBe(target)
  })
})
