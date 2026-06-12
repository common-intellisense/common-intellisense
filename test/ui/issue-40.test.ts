import { afterEach, describe, expect, it } from 'vitest'
import { getActiveText, getActiveTextEditorLanguageId, getCurrentFileUrl } from '@vscode-use/utils'
import { detectSlots, registerCodeLensProviderFn } from '../../src/parser'
import { propsReducer } from '../../src/ui/utils'

const mockActiveText = getActiveText as any
const mockCurrentFileUrl = getCurrentFileUrl as any
const mockLanguageId = getActiveTextEditorLanguageId as any

afterEach(async () => {
  mockActiveText.mockReturnValue('')
  mockCurrentFileUrl.mockReturnValue('')
  mockLanguageId.mockReturnValue('')
  await detectSlots({}, {}, [])
})

describe('issue 40 regressions', () => {
  it('keeps CodeLens working when a template slot has no value', async () => {
    mockCurrentFileUrl.mockReturnValue('/fixtures/App.vue')
    mockLanguageId.mockReturnValue('vue')
    mockActiveText.mockReturnValue(`
<template>
  <MyComp>
    <template slot></template>
    <template slot="footer"></template>
  </MyComp>
</template>
`)

    await detectSlots({
      MyComp: {
        rawSlots: [
          { name: 'default', description: 'default slot' },
          { name: 'footer', description: 'footer slot' },
          { name: 'header', description: 'header slot' },
        ],
      },
    }, {}, [])

    const provider = registerCodeLensProviderFn() as any
    const lenses = provider.provideCodeLenses()

    expect(lenses.map((lens: any) => lens.command.title)).toEqual([
      'Slots: default',
      'header',
    ])
  })

  it('creates valid slash snippets and keeps only version-compatible members', async () => {
    const result = await propsReducer({
      uiName: 'fixture2.0.0',
      lib: '__missing_package__',
      map: [{
        name: 'Demo',
        props: {
          placement: { default: '', value: '', type: '\'top\' / "bottom" / ' },
          untyped: { default: '', value: '' },
          oldProp: { default: '', value: '', type: 'string', version: '1.0.0' },
          currentProp: { default: '', value: '', type: 'string', version: '2.0.0' },
          futureProp: { default: '', value: '', type: 'string', version: '3.0.0' },
        },
        events: [
          { name: 'old-event', version: '1.0.0' },
          { name: 'current-event', version: '2.0.0' },
          { name: 'future-event', version: '3.0.0' },
        ],
        methods: [
          { name: 'oldMethod', version: '1.0.0' },
          { name: 'currentMethod', version: '2.0.0' },
          { name: 'futureMethod', version: '3.0.0' },
        ],
        exposed: [
          { name: 'oldExpose', detail: '()', version: '1.0.0' },
          { name: 'currentExpose', detail: '()', version: '2.0.0' },
          { name: 'futureExpose', detail: '()', version: '3.0.0' },
        ],
        slots: [
          { name: 'old-slot', version: '1.0.0' },
          { name: 'current-slot', version: '2.0.0' },
          { name: 'future-slot', version: '3.0.0' },
        ],
      }],
    })

    const completions = result.Demo.completions[0](true)
    expect(completions.find(item => item.content === 'placement=""')?.snippet).toBe('placement="${1|top,bottom|}"')
    expect(completions.find(item => item.content === 'untyped=""')?.snippet).toBe('untyped="${1}"')

    const propContents = completions.map(item => item.content)
    expect(propContents).toContain('oldProp=""')
    expect(propContents).toContain('currentProp=""')
    expect(propContents).not.toContain('futureProp=""')

    const eventNames = result.Demo.events[0](true).map(item => (item as any).params[1])
    expect(eventNames).toContain('old-event')
    expect(eventNames).toContain('current-event')
    expect(eventNames).not.toContain('future-event')

    const methodContents = result.Demo.methods.map(item => item.content)
    expect(methodContents).toContain('oldMethod')
    expect(methodContents).toContain('currentMethod')
    expect(methodContents).not.toContain('futureMethod')

    const exposedContents = result.Demo.exposed.map(item => item.content)
    expect(exposedContents).toContain('oldExpose')
    expect(exposedContents).toContain('currentExpose')
    expect(exposedContents).not.toContain('futureExpose')

    const slotContents = result.Demo.slots.map(item => item.content)
    expect(slotContents).toContain('slot="old-slot"')
    expect(slotContents).toContain('slot="current-slot"')
    expect(slotContents).not.toContain('slot="future-slot"')
  })
})
