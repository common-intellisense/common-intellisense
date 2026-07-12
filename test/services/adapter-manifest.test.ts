import { describe, expect, it } from 'vitest'
import { normalizeAdapterManifestExports } from '../../src/services/adapter-manifest'

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
          events: [{ name: 'change' }],
          methods: [{ name: 'focus' }],
          exposed: [{ name: 'focus' }],
          slots: [{ name: 'default' }],
        }],
      },
    }, 'fixture') as any

    expect(exportsData.demo.map[0].props.disabled.type).toBe('boolean')
    expect(exportsData.demoComponents.map[0][0]).toBe('Demo')
  })

  it.each([
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { disabled: null } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { type: 42 } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', exposed: [{ name: 'focus', version: 3 }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', suggestions: [{ name: 42 }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { related: [42] } } }] },
  ])('rejects malformed props before reducers are created', (value) => {
    expect(() => normalizeAdapterManifestExports({ demo: value }, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })
})
