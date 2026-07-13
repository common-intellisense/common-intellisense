import { describe, expect, it } from 'vitest'
import { normalizeAdapterManifestExports } from '../../src/services/adapter-manifest'
import { propsReducer } from '../../src/ui/utils'

describe('data-only adapter manifest validation', () => {
  it('accepts valid component and props exports', () => {
    const exportsData = normalizeAdapterManifestExports({
      demoComponents: { lib: 'demo', prefix: 'd', map: [['Demo', 'Demo detail']] },
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{
          name: 'Demo',
          props: { disabled: { type: 'boolean', required: false, default: false } },
          events: [{ name: 'change', required: false, ignored: 'not-public' }],
          methods: [{ name: 'focus' }],
          exposed: [{ name: 'focus' }],
          slots: [{ name: 'default' }],
        }],
      },
    }, 'fixture') as any

    expect(exportsData.demo.map[0].props.disabled.type).toBe('boolean')
    expect(exportsData.demoComponents.map[0][0]).toBe('Demo')
    expect(exportsData.demo.map[0].events[0].required).toBe(false)
    expect(exportsData.demo.map[0].events[0].ignored).toBeUndefined()
  })

  it('validates and clones component directives', () => {
    const exportsData = normalizeAdapterManifestExports({
      demoComponents: {
        lib: 'demo',
        directives: [{ name: 'loading', description: 'Loading', params: [{ name: 'delay', type: 'number', default: 0 }] }],
        map: [['Demo', 'Demo']],
      },
    }, 'fixture') as any
    expect(exportsData.demoComponents.directives[0].params[0]).toMatchObject({ name: 'delay', type: 'number' })
  })

  it('keeps reducer execution safe when a configured prefix is longer than the component name', async () => {
    const exportsData = normalizeAdapterManifestExports({
      demo: { uiName: 'demo', lib: 'demo', prefix: 'VeryLongPrefix', map: [{ name: 'A', props: { value: { type: 'string' } } }] },
    }, 'fixture') as any
    const reduced = await propsReducer(exportsData.demo)
    expect(reduced.A).toBeDefined()
    expect(reduced.A.completions[0]({ languageId: 'vue', framework: 'vue', syntax: 'template', uri: '' })).toBeTruthy()
  })

  it.each([
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { disabled: null } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { type: 42 } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', exposed: [{ name: 'focus', version: 3 }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', suggestions: [{ name: 42 }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { related: [42] } } }] },
    { lib: 'demo', directives: {}, map: [['Demo', 'Demo']] },
    { lib: 'demo', directives: [{ name: 'loading', params: [{ name: 'delay' }] }], map: [['Demo', 'Demo']] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { ':': { type: 'string' } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', events: [{ name: 'click', kind: 'invalid' }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', events: [{ name: 'submit', required: 'false' }] }] },
  ])('rejects malformed props before reducers are created', (value) => {
    expect(() => normalizeAdapterManifestExports({ demo: value }, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })
})
