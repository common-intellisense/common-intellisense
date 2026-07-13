import { describe, expect, it } from 'vitest'
import { clearDocumentAnalysis, detectSlots, getDocumentSlotAnalysis, getImportDeps, parser } from '../src/parser'

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

  it.each(['tsx', 'jsx'])('uses script-relative coordinates while retaining the Vue host for %s', (lang) => {
    const code = `<template><div /></template>

<script setup lang="${lang}">
const buttonRef = ref()
const button = <ElButton ref={buttonRef} size="small" />
</script>`
    const tag = parseAt(code, 'ElButton') as any
    const prop = parseAt(code, 'size') as any
    expect(tag).toMatchObject({ type: 'tag', tag: 'ElButton', hostFramework: 'vue', syntax: 'jsx', vueBlock: 'scriptSetup', blockLang: lang })
    expect(prop).toMatchObject({ type: 'props', tag: 'ElButton', propName: 'size', hostFramework: 'vue', syntax: 'jsx' })
    expect(tag.refsMap).toMatchObject({ buttonRef: 'ElButton' })
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
    expect(groups.every((group: any) => group.offset === 0)).toBe(true)
    expect(groups.some((group: any) => group.children.some((entry: any) => entry.child.openingElement))).toBe(false)
  })

  it.each([
    ['tsx', 'script'],
    ['jsx', 'script setup'],
  ])('analyzes slots in render-only Vue %s blocks', async (lang, block) => {
    clearDocumentAnalysis()
    const code = `<${block} lang="${lang}">const view = <MyComponent /></${block}>`
    const document = {
      languageId: 'vue',
      version: 1,
      uri: { toString: () => `file:///Render-${lang}.vue` },
      getText: () => code,
    } as any
    await detectSlots(document, { MyComponent: { rawSlots: [{ name: 'default' }] } }, {}, [], {
      packagePath: '/workspace/package.json',
      contextGeneration: 1,
      contextRevision: 1,
    })
    const groups = getDocumentSlotAnalysis(document.uri)?.children || []
    expect(groups.some((group: any) => group.offset > 0 && group.children.some((entry: any) => entry.child.openingElement?.name?.name === 'MyComponent'))).toBe(true)
  })

  it('parses local imports per block and lets setup bindings win in template scope', () => {
    const code = `<script lang="ts">
const state = createModuleState()
import NormalWrapper from './NormalWrapper.vue'
</script>
<script setup lang="ts">
const state = ref(0)
import NormalWrapper from './SetupWrapper.vue'
const AsyncButton = defineAsyncComponent(() => import('./AsyncButton.vue'))
</script>`
    const normalOffset = code.indexOf('const state = createModuleState')
    expect(getImportDeps(code, { activeOffset: normalOffset })).toEqual({ NormalWrapper: './NormalWrapper.vue' })
    expect(getImportDeps(code)).toMatchObject({
      NormalWrapper: './SetupWrapper.vue',
      AsyncButton: './AsyncButton.vue',
    })
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
    expect(normal).toMatchObject({ type: 'script', refs: ['normalRef'] })
    expect(setup).toMatchObject({ type: 'script', refs: ['buttonRef'] })
    expect((normal as any).loc.source).toContain('normalRef')
    expect((setup as any).loc.source).toContain('buttonRef')
  })
})
