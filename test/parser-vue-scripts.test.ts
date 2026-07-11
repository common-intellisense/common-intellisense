import { describe, expect, it } from 'vitest'
import { clearDocumentAnalysis, detectSlots, getDocumentSlotAnalysis, parser } from '../src/parser'

function positionIn(code: string, needle: string) {
  const offset = code.indexOf(needle)
  const before = code.slice(0, offset)
  const lines = before.split('\n')
  return {
    position: { line: lines.length - 1, character: lines.at(-1)!.length } as any,
    offset,
  }
}

function parseAt(code: string, needle: string) {
  const { position, offset } = positionIn(code, needle)
  return parser(code, position, { languageId: 'vue', uri: 'file:///App.vue', offset })
}

describe('vue script block selection', () => {
  it('handles a normal script without script setup', () => {
    const code = '<script>\nconst normalRef = ref()\nnormalRef.value\n</script>'
    expect(parseAt(code, 'normalRef.value')).toMatchObject({
      type: 'script',
      refs: ['normalRef'],
    })
  })

  it('handles script setup without a normal script', () => {
    const code = '<script setup>\nconst setupRef = ref()\nsetupRef.value\n</script>'
    expect(parseAt(code, 'setupRef.value')).toMatchObject({
      type: 'script',
      refs: ['setupRef'],
    })
  })

  it('uses script-relative coordinates while retaining the Vue host for TSX', () => {
    const code = `<template><div /></template>

<script setup lang="tsx">
const button = <ElButton size="small" />
</script>`
    const tag = parseAt(code, 'ElButton') as any
    const prop = parseAt(code, 'size') as any
    expect(tag).toMatchObject({ type: 'tag', tag: 'ElButton', hostFramework: 'vue' })
    expect(prop).toMatchObject({ type: 'props', tag: 'ElButton', propName: 'size', hostFramework: 'vue' })
    expect(tag.template).toBeDefined()
  })

  it('keeps template slot analysis when a TSX script is also present', async () => {
    clearDocumentAnalysis()
    const code = `<template><UiTable /></template>\n<script setup lang="tsx">const icon = <UiIcon /></script>`
    const document = {
      languageId: 'vue',
      version: 1,
      uri: { toString: () => 'file:///App.vue' },
      getText: () => code,
    } as any
    const table = { rawSlots: [{ name: 'default' }] }
    await detectSlots(document, { UiTable: table, UiIcon: { rawSlots: [{ name: 'icon' }] } }, {}, [], {
      packagePath: '/workspace/package.json',
      contextGeneration: 1,
      contextRevision: 1,
    })
    const groups = getDocumentSlotAnalysis(document.uri)?.children || []
    expect(groups.some((group: any) => group.offset === 0 && group.children.some((entry: any) => entry.child.tag === 'UiTable'))).toBe(true)
  })

  it('uses either active block and aggregates refs from both blocks', () => {
    const code = `<script>
const normalRef = ref()
normalRef.value
</script>
<script setup lang="ts">
const buttonRef = ref()
buttonRef.value
</script>
<template><UiButton ref="buttonRef" /></template>`

    const normal = parseAt(code, 'normalRef.value')
    const setup = parseAt(code, 'buttonRef.value')
    expect(normal).toMatchObject({ type: 'script', refs: ['normalRef', 'buttonRef'] })
    expect(setup).toMatchObject({ type: 'script', refs: ['normalRef', 'buttonRef'] })
    expect((normal as any).loc.source).toContain('normalRef')
    expect((setup as any).loc.source).toContain('buttonRef')
  })
})
