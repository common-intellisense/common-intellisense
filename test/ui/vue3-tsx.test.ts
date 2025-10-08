import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getImportDeps, findDynamicComponent } from '../../src/parser'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures-vue3')
const tsxFile = path.join(fixturesDir, 'Render.tsx')

beforeAll(async () => {
  await fsp.mkdir(fixturesDir, { recursive: true })
  const content = `
import React from 'react'
import Pagination from './Pagination.vue'

export default function Render() {
  return <Pagination />
}
`
  await fsp.writeFile(tsxFile, content, 'utf8')
  // also create the Pagination.vue referenced
  const pcontent = `<template><div/></template><script>export default {}</script>`
  await fsp.writeFile(path.join(fixturesDir, 'Pagination.vue'), pcontent, 'utf8')
})

afterAll(async () => {
  try {
    await fsp.rm(tsxFile)
    await fsp.rm(path.join(fixturesDir, 'Pagination.vue'))
    await fsp.rmdir(fixturesDir)
  }
  catch {}
})

describe('Vue3 TSX mapping', () => {
  it('extracts imports from TSX and maps render-used components', async () => {
    const code = await fsp.readFile(tsxFile, 'utf8')
    const deps = getImportDeps(code)
    expect(deps.Pagination).toBe('./Pagination.vue')

    const UiCompletions: any = { Pagination: { uiName: 'Pagination' } }
    const found = await findDynamicComponent('Pagination', deps, UiCompletions, [])
    expect(found).toBe(UiCompletions.Pagination)
  })
})
