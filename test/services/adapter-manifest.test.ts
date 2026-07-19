import { describe, expect, it } from 'vitest'
import { normalizeAdapterManifestExports } from '../../src/services/adapter-manifest'
import { componentsReducer, propsReducer } from '../../src/ui/utils'

describe('data-only adapter manifest validation', () => {
  it('accepts valid component and props exports', () => {
    const exportsData = normalizeAdapterManifestExports({
      demoComponents: { lib: 'demo', prefix: 'd', map: [['Demo', 'Demo detail']] },
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{
          name: 'Demo',
          props: { disabled: { type: 'boolean', required: false, default: false }, size: { value: ['small', 'large'] } },
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
    expect(exportsData.demo.map[0].props.size.value).toEqual(['small', 'large'])
    expect(exportsData.demo.map[0].events[0].ignored).toBeUndefined()
  })

  it.each([
    ' foo',
    'foo ',
    'foo\nbar',
    'foo" bar="baz',
    'foo></template><script>x()</script>',
    '${1:placeholder}',
    'foo|bar',
    'foo\\bar',
  ])('rejects unsafe source token %j across manifest names', (token) => {
    const manifests = [
      { uiName: 'demo', lib: 'demo', map: [{ name: token }] },
      { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { [token]: {} } }] },
      { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', events: [{ name: token }] }] },
      { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', slots: [{ name: token }] }] },
      { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', methods: [{ name: token }] }] },
      { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', exposed: [{ name: token }] }] },
      { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', suggestions: [token] }] },
    ]
    for (const manifest of manifests)
      expect(() => normalizeAdapterManifestExports({ demo: manifest }, 'fixture')).toThrow(/Invalid adapter manifest field/)
    expect(() => normalizeAdapterManifestExports({ demoComponents: { lib: 'demo', directives: [{ name: token }], map: [['Demo', 'Demo']] } }, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })

  it('accepts safe static source tokens and rejects unknown component DSL fields', () => {
    expect(() => normalizeAdapterManifestExports({
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{
          name: 'Namespace.Component',
          props: { ':model-value': {} },
          events: [{ name: 'update:modelValue' }],
          slots: [{ name: 'header-extra' }],
        }],
      },
    }, 'fixture')).not.toThrow()
    expect(() => normalizeAdapterManifestExports({
      demo: { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', unexpected: true }] },
    }, 'fixture')).toThrow(/Invalid adapter manifest field/)
    expect(() => normalizeAdapterManifestExports({
      demo: { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { value: { $parent: 'unsafe' } } }] },
    }, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })

  it('accepts JavaScript dollar-prefixed method and exposed member names', () => {
    expect(() => normalizeAdapterManifestExports({
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{ name: 'Demo', methods: [{ name: '$reset' }, { name: '$reset()' }], exposed: [{ name: '$refs' }] }],
      },
    }, 'fixture')).not.toThrow()
  })

  it('accepts empty strings in snippet value fields', () => {
    expect(() => normalizeAdapterManifestExports({
      demoComponents: {
        lib: 'demo',
        directives: [{ name: 'loading', params: [{ name: 'label', type: 'string', default: '', value: '' }] }],
        map: [['Demo', 'Demo']],
      },
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{ name: 'Demo', props: { label: { default: '', value: '' } }, events: [{ name: 'change', value: '' }], methods: [{ name: 'reset', value: '' }] }],
      },
    }, 'fixture')).not.toThrow()
  })

  it('preserves directive link_zh metadata', () => {
    const exportsData = normalizeAdapterManifestExports({
      demoComponents: { lib: 'demo', directives: [{ name: 'loading', link: '/en', link_zh: '/zh' }], map: [['Demo', 'Demo']] },
    }, 'fixture') as any

    expect(exportsData.demoComponents.directives[0].link_zh).toBe('/zh')
  })

  it('uses component-level sources consistently for props and planned completion imports', async () => {
    const exportsData = normalizeAdapterManifestExports({
      demoComponents: {
        lib: 'demo',
        dynamicLib: '@demo/${name}',
        map: [[{ name: 'Parent', from: '@custom/parent', suggestions: ['Child'] }, 'Parent'], [{ name: 'Child', from: '@custom/child' }, 'Child']],
      },
      demo: { uiName: 'demo', lib: 'demo', dynamicLib: '@demo/${name}', map: [{ name: 'Parent', from: '@custom/parent' }] },
    }, 'fixture') as any

    const props = await propsReducer(exportsData.demo)
    expect(props.Parent.lib).toBe('@custom/parent')

    const [provider] = componentsReducer(exportsData.demoComponents)
    const completions = await Promise.all(provider.data(undefined, { languageId: 'vue', framework: 'vue', syntax: 'template', uri: '' })) as any[]
    const parent = completions.find(item => item.params.data.name === 'Parent')
    expect(parent.params.data.__imports).toEqual([
      { localName: 'Parent', source: '@custom/parent', importWay: 'specifier' },
      { localName: 'Child', source: '@custom/child', importWay: 'specifier' },
    ])
  })

  it('renders a nested suggestion only when exactly one is declared', async () => {
    const exportsData = normalizeAdapterManifestExports({
      demoComponents: { lib: 'demo', map: [[{ name: 'Parent', suggestions: ['Child', 'Other'] }, 'Parent']] },
    }, 'fixture') as any
    const [provider] = componentsReducer(exportsData.demoComponents)
    const [parent] = await Promise.all(provider.data(undefined, { languageId: 'vue', framework: 'vue', syntax: 'template', uri: '' })) as any[]

    expect(parent.snippet).not.toContain('<Child')
    expect(parent.params.data.__imports).toEqual([{ localName: 'Parent', source: 'demo', importWay: 'specifier' }])
  })

  it('accepts bounded enum values that are escaped by the snippet renderer', () => {
    expect(() => normalizeAdapterManifestExports({
      demo: { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { value: ['a,b', 'c|d', 'e}f', 'g\\h'] } } }] },
    }, 'fixture')).not.toThrow()
  })

  it('rejects thenable export keys before crossing an async boundary', () => {
    expect(() => normalizeAdapterManifestExports({ then: { uiName: 'then', lib: 'demo', map: [] } }, 'fixture')).toThrow('Unsafe adapter export key')
  })

  it.each(['__proto__', 'prototype', 'constructor', 'then'])('rejects unsafe nested object key %s without polluting prototypes', (key) => {
    const manifest = JSON.parse(JSON.stringify({
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{ name: 'Demo', suggestions: [{ name: 'Other' }] }],
      },
    }))
    Object.defineProperty(manifest.demo.map[0].suggestions[0], key, {
      value: { polluted: true },
      enumerable: true,
    })

    expect(() => normalizeAdapterManifestExports(manifest, 'fixture')).toThrow(/Invalid adapter manifest field/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it.each(['__proto__', 'prototype', 'constructor', 'then'])('rejects unsafe typeDetail key %s', (key) => {
    const typeDetail = Object.create(null)
    typeDetail[key] = [{ name: 'unsafe' }]
    const manifest = {
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{ name: 'Demo', typeDetail }],
      },
    }

    expect(() => normalizeAdapterManifestExports(manifest, 'fixture')).toThrow(/Invalid adapter manifest field/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
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

  it('accepts directive and method param limits at the boundary', () => {
    expect(() => normalizeAdapterManifestExports({
      demoComponents: {
        lib: 'demo',
        directives: Array.from({ length: 250 }, (_, index) => ({
          name: `directive${index}`,
          params: index === 0 ? Array.from({ length: 250 }, (_, paramIndex) => ({ name: `param${paramIndex}`, type: 'string' })) : [],
        })),
        map: [['Demo', 'Demo']],
      },
      demo: {
        uiName: 'demo',
        lib: 'demo',
        map: [{ name: 'Demo', methods: [{ name: 'open', params: Array.from({ length: 250 }, (_, index) => `param${index}`) }] }],
      },
    }, 'fixture')).not.toThrow()
  })

  it('keeps reducer execution safe when a configured prefix is longer than the component name', async () => {
    const exportsData = normalizeAdapterManifestExports({
      demo: { uiName: 'demo', lib: 'demo', prefix: 'VeryLongPrefix', map: [{ name: 'A', props: { value: { type: 'string' } } }] },
    }, 'fixture') as any
    const reduced = await propsReducer(exportsData.demo)
    expect(reduced.A).toBeDefined()
    expect(reduced.A.completions[0]({ languageId: 'vue', framework: 'vue', syntax: 'template', uri: '' })).toBeTruthy()
  })

  it('limits data-only component manifests before eager completion rendering', async () => {
    const makeMap = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => [`${prefix}${index}`, `${prefix} ${index}`])
    const boundary = normalizeAdapterManifestExports({
      demoComponents: { lib: 'demo', map: makeMap(500, 'Demo') },
    }, 'fixture') as any
    const [provider] = componentsReducer(boundary.demoComponents)

    expect(await Promise.all(provider.data(undefined, { languageId: 'vue', framework: 'vue', uri: '' }))).toHaveLength(500)
    expect(() => normalizeAdapterManifestExports({
      demoComponents: { lib: 'demo', map: makeMap(501, 'Demo') },
    }, 'fixture')).toThrow(/Invalid adapter manifest field/)
    expect(() => normalizeAdapterManifestExports({
      firstComponents: { lib: 'first', map: makeMap(500, 'First') },
      secondComponents: { lib: 'second', map: makeMap(500, 'Second') },
      thirdComponents: { lib: 'third', map: makeMap(1, 'Third') },
    }, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })

  it.each([
    { demoComponents: { lib: 'demo', map: [['Demo', 'x'.repeat(10_001)]] } },
    { demoComponents: { lib: 'demo', map: [['Demo', 'detail', 'x'.repeat(64 * 1024 + 1)]] } },
    {
      demoComponents: {
        lib: 'demo',
        directives: Array.from({ length: 251 }, (_, index) => ({ name: `directive${index}` })),
        map: [['Demo', 'Demo']],
      },
    },
    {
      demoComponents: {
        lib: 'demo',
        directives: [{ name: 'loading', params: Array.from({ length: 251 }, (_, index) => ({ name: `param${index}`, type: 'string' })) }],
        map: [['Demo', 'Demo']],
      },
    },
    {
      demoComponents: {
        lib: 'demo',
        map: [['Demo', 'Demo detail', 'Demo import', 'unexpected']],
      },
    },
  ])('rejects oversized directive metadata and component tuples', (manifest) => {
    expect(() => normalizeAdapterManifestExports(manifest, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })

  it.each([
    (index: number) => ({
      name: `Props${index}`,
      props: Object.fromEntries(Array.from({ length: 250 }, (_, memberIndex) => [`prop${memberIndex}`, {}])),
    }),
    (index: number) => ({
      name: `Events${index}`,
      events: Array.from({ length: 250 }, (_, memberIndex) => ({ name: `event${memberIndex}` })),
    }),
    (index: number) => ({
      name: `Suggestions${index}`,
      suggestions: Array.from({ length: 250 }, (_, memberIndex) => `Suggestion${memberIndex}`),
    }),
  ])('enforces aggregate budgets for direct component members', (component) => {
    expect(() => normalizeAdapterManifestExports({
      demo: { uiName: 'demo', lib: 'demo', map: Array.from({ length: 81 }, (_, index) => component(index)) },
    }, 'fixture')).toThrow(/Invalid adapter manifest field: fixture\.members/)
  })

  it.each([
    ...['__proto__', 'prototype', 'constructor', 'then', 'icons'].map(name => ({ uiName: 'demo', lib: 'demo', map: [{ name }] })),
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { disabled: null } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { type: 42 } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', exposed: [{ name: 'focus', version: 3 }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', suggestions: [{ name: 42 }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { related: [42] } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { value: { unexpected: true } } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { value: [1, 2] } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { value: 1 } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { value: null } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', suggestions: Array.from({ length: 251 }, (_, index) => `Item${index}`) }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { size: { related: Array.from({ length: 251 }, (_, index) => `prop${index}`) } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', typeDetail: { options: Array.from({ length: 251 }, (_, index) => ({ name: `item${index}` })) } }] },
    { lib: 'demo', directives: {}, map: [['Demo', 'Demo']] },
    { lib: 'demo', directives: [{ name: 'loading', params: [{ name: 'delay' }] }], map: [['Demo', 'Demo']] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', methods: [{ name: 'open', params: Array.from({ length: 251 }, (_, index) => `param${index}`) }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', events: [{ name: 'change', params: Array.from({ length: 251 }, (_, index) => `param${index}`) }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', methods: [{ name: 'open', params: 'x'.repeat(10_001) }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', typeDetail: { options: 'x'.repeat(10_001) } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', methods: [{ name: 'open', params: ['x'.repeat(10_001)] }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', props: { ':': { type: 'string' } } }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', events: [{ name: 'click', kind: 'invalid' }] }] },
    { uiName: 'demo', lib: 'demo', map: [{ name: 'Demo', events: [{ name: 'submit', required: 'false' }] }] },
  ])('rejects malformed props before reducers are created', (value) => {
    expect(() => normalizeAdapterManifestExports({ demo: value }, 'fixture')).toThrow(/Invalid adapter manifest field/)
  })
})
