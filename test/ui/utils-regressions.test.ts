import { describe, expect, it, vi } from 'vitest'

const mockGetLocale = vi.fn(() => 'en')
const mockGetActiveTextEditorLanguageId = vi.fn(() => 'vue')
const mockGetCurrentFileUrl = vi.fn(() => '/fixtures/App.vue')
const mockGetConfiguration = vi.fn(() => undefined)
const mockSetCommandParams = vi.fn((value: any) => `encoded:${Array.isArray(value) ? value.join('|') : value}`)
const mockResolveInstalledPackageVersion = vi.fn(async () => undefined)
const mockCreateCompletionItem = vi.fn((options: any) => ({ ...options }))
const mockCreateHover = vi.fn((documentation: any) => ({ documentation }))

vi.mock('@vscode-use/utils', () => ({
  createCompletionItem: mockCreateCompletionItem,
  createHover: mockCreateHover,
  createMarkdownString: () => new MarkdownString(),
  getActiveTextEditorLanguageId: mockGetActiveTextEditorLanguageId,
  getConfiguration: mockGetConfiguration,
  getCurrentFileUrl: mockGetCurrentFileUrl,
  getLocale: mockGetLocale,
  getRootPath: () => '/tmp',
  setCommandParams: mockSetCommandParams,
}))

vi.mock('../../src/services/package-version', () => ({
  resolveInstalledPackageVersion: mockResolveInstalledPackageVersion,
}))

vi.mock('../../src/ui/ui-find', () => ({
  logger: { error: vi.fn() },
}))

class MarkdownString {
  value = ''
  isTrusted: boolean | { enabledCommands: string[] } = false
  supportHtml = false

  appendMarkdown(markdown: string) {
    this.value += markdown
  }

  appendCodeblock(code: string, language?: string) {
    this.value += `\n\n\n[code:${language || ''}]\n${code}\n[/code]`
  }
}

vi.mock('vscode', () => ({
  MarkdownString,
  CompletionItemKind: {
    Property: 5,
    Enum: 12,
    Event: 23,
    TypeParameter: 24,
  },
}))

describe('utils reducer regressions', () => {
  it('propsReducer keeps prop metadata immutable, preserves global defaults, and uses command trust allowlist', async () => {
    const { propsReducer } = await import('../../src/ui/utils')

    const component = {
      name: 'Demo',
      link: 'https://example.com/docs',
      dynamicLib: '@scope/${name}',
      props: {
        visible: {
          default: false,
          value: '',
          type: 'boolean',
          description: 'visibility',
        },
        placement: {
          default: 1,
          value: '',
          type: ['top', 'bottom'],
        },
      },
      events: [],
    }

    const result = await propsReducer({
      uiName: 'fixture',
      lib: 'fixture-lib',
      dynamicLib: 'global-${name}',
      map: [component as any],
    })

    const completions = result.Demo.completions[0](true)
    const visibleCompletion = completions.find(item => item.content.startsWith('visible'))
    const placementCompletion = completions.find(item => item.content.startsWith('placement'))

    expect(visibleCompletion?.snippet).toBe('visible')
    expect(placementCompletion?.propType).toBe('top / bottom')
    expect(component.props.visible.default).toBe(false)
    expect(component.props.placement.type).toEqual(['top', 'bottom'])
    expect(component.events).toEqual([])
    expect(result.Demo.lib).toBe('@scope/demo')

    const propDocumentation = visibleCompletion?.documentation as any
    expect(propDocumentation.isTrusted).toEqual({
      enabledCommands: [
        'intellisense.openDocument',
        'intellisense.openDocumentExternal',
        'intellisense.copyDemo',
      ],
    })
    expect(propDocumentation.supportHtml).toBe(false)
    expect(result.Demo.tableDocument.isTrusted).toEqual({
      enabledCommands: [
        'intellisense.openDocument',
        'intellisense.openDocumentExternal',
        'intellisense.copyDemo',
      ],
    })
  })

  it('renders completion syntax from the supplied document context, not the active editor', async () => {
    const { componentsReducer, propsReducer } = await import('../../src/ui/utils')
    mockGetCurrentFileUrl.mockReturnValue('/fixtures/Active.vue')
    mockGetActiveTextEditorLanguageId.mockReturnValue('vue')

    const props = await propsReducer({
      uiName: 'fixture',
      lib: 'fixture-lib',
      installedVersion: '1.0.0',
      map: [{ name: 'Demo', props: { className: { type: 'string' } }, events: [] }] as any,
    })
    const svelteContext = { languageId: 'svelte', framework: 'svelte' as const, uri: 'file:///Svelte.svelte' }
    expect(props.Demo.events[0](svelteContext).some(item => item.content.startsWith('onclick='))).toBe(true)
    const svelteCompletions = props.Demo.completions[0](svelteContext)
    expect(svelteCompletions.some(item => item.content === 'class')).toBe(true)
    expect(svelteCompletions.some(item => item.content === 'className')).toBe(false)
    expect(svelteCompletions.find(item => item.content === 'style')?.snippet).toBe('style="$1"')

    const [components] = componentsReducer({ lib: 'fixture-lib', map: [[{ name: 'Demo' }, 'Demo']] as any })
    const react = await Promise.all(components.data(undefined, { languageId: 'typescriptreact', framework: 'react', uri: 'file:///Demo.tsx' }))
    expect((react[0] as any).snippet).toContain('<Demo')
    expect((react[0] as any).snippet).not.toContain('<demo')

    const [, unprefixed] = componentsReducer({ lib: 'element-plus', prefix: 'El', map: [[{ name: 'ElButton' }, 'Button']] as any })
    const [tsxButton] = await Promise.all(unprefixed.data(undefined, {
      languageId: 'vue',
      hostFramework: 'vue',
      syntax: 'jsx',
      framework: 'react',
      uri: 'file:///Demo.vue',
    })) as any[]
    expect(tsxButton.snippet).toContain('<Button')
    expect(tsxButton.params.data.name).toBe('Button')
    expect(tsxButton.params.requiresImport).toBe(true)

    const [templateButton] = await Promise.all(unprefixed.data(undefined, {
      languageId: 'vue',
      hostFramework: 'vue',
      syntax: 'template',
      framework: 'vue',
      uri: 'file:///Demo.vue',
    })) as any[]
    expect(templateButton.snippet).toContain('<el-button')
    expect(templateButton.params.requiresImport).toBe(true)

    const [templateDirect] = await Promise.all(components.data(undefined, {
      languageId: 'vue',
      hostFramework: 'vue',
      syntax: 'template',
      framework: 'vue',
      uri: 'file:///Demo.vue',
    })) as any[]
    expect(templateDirect.params.requiresImport).toBe(false)

    const [svelteButton] = await Promise.all(components.data(undefined, {
      languageId: 'svelte',
      hostFramework: 'svelte',
      syntax: 'template',
      framework: 'svelte',
      uri: 'file:///Demo.svelte',
    })) as any[]
    expect(svelteButton.params.requiresImport).toBe(true)
  })

  it('uses the same Svelte event names for optional and required snippets', async () => {
    const { getRequireProp, propsReducer } = await import('../../src/ui/utils')
    const events = [
      { name: 'click', kind: 'dom', required: true },
      { name: 'onclick', kind: 'dom', required: true },
      { name: 'inflate', kind: 'component', required: true },
    ] as any
    const props = await propsReducer({ uiName: 'fixture', lib: 'fixture', map: [{ name: 'Demo', props: {}, events }] as any })
    const context = { languageId: 'svelte', framework: 'svelte' as const, uri: 'file:///Demo.svelte' }
    const optional = props.Demo.events[0](context).map(item => item.content)
    expect(optional).toContain('onclick={onclick}')
    expect(optional).toContain('inflate={inflate}')
    expect(optional).not.toContain('ononclick={ononclick}')

    const [required] = await getRequireProp({ props: {}, events }, 0, 'svelte')
    expect(required.filter(item => item.startsWith('onclick='))).toHaveLength(2)
    expect(required.some(item => item.startsWith('inflate='))).toBe(true)
    expect(required.some(item => item.startsWith('oninflate='))).toBe(false)
  })

  it('keeps same-major APIs when only an alias adapter major is known', async () => {
    const { propsReducer } = await import('../../src/ui/utils')
    const component = {
      name: 'Demo',
      props: { newer: { type: 'string', version: '2.6.0' }, future: { type: 'string', version: '3.0.0' } },
      slots: [{ name: 'newer-slot', version: '2.6.0' }, { name: 'future-slot', version: '3.0.0' }],
    }
    const props = await propsReducer({ uiName: 'elementUi2', lib: 'element-ui', adapterMajor: '2', map: [component] as any })
    const vue = { languageId: 'vue', framework: 'vue' as const, uri: 'file:///Demo.vue' }

    expect(props.Demo.completions[0](vue).some(item => item.content.startsWith('newer'))).toBe(true)
    expect(props.Demo.completions[0](vue).some(item => item.content.startsWith('future'))).toBe(false)
    expect(props.Demo.tableDocument.value).toContain('newer')
    expect(props.Demo.rawSlots?.map(slot => slot.name)).toEqual(['newer-slot'])
  })

  it('uses the package-specific installed version for API filtering', async () => {
    const { propsReducer } = await import('../../src/ui/utils')
    const component = { name: 'Demo', props: { old: { type: 'string' }, newer: { type: 'string', version: '2.6.0' } } }
    const legacy = await propsReducer({ uiName: 'fixture2', lib: 'fixture-lib', installedVersion: '2.4.0', map: [component] as any })
    const current = await propsReducer({ uiName: 'fixture2', lib: 'fixture-lib', installedVersion: '2.8.0', map: [component] as any })
    const vue = { languageId: 'vue', framework: 'vue' as const, uri: 'file:///Demo.vue' }
    expect(legacy.Demo.completions[0](vue).some(item => item.content.startsWith('newer'))).toBe(false)
    expect(current.Demo.completions[0](vue).some(item => item.content.startsWith('newer'))).toBe(true)
  })

  it('uses the same version-filtered model for completions, hover tables, and slots', async () => {
    const { propsReducer } = await import('../../src/ui/utils')
    const legacy = await propsReducer({
      uiName: 'fixture3',
      lib: 'fixture-lib',
      installedVersion: '2.4.0',
      map: [{
        name: 'Demo',
        props: { old: { type: 'string' }, newer: { type: 'string', version: '2.6.0' } },
        methods: [{ name: 'newMethod', version: '2.6.0' }],
        events: [{ name: 'new-event', version: '2.6.0' }],
        slots: [{ name: 'new-slot', version: '2.6.0' }],
      }] as any,
    })
    expect(legacy.Demo.tableDocument.value).not.toContain('newer')
    expect(legacy.Demo.tableDocument.value).not.toContain('newMethod')
    expect(legacy.Demo.tableDocument.value).not.toContain('new-event')
    expect(legacy.Demo.tableDocument.value).not.toContain('new-slot')
    expect(legacy.Demo.rawSlots).toEqual([])
  })

  it('indexes large component suggestion maps once with normalized aliases', async () => {
    const { createComponentSuggestionIndex } = await import('../../src/ui/utils')
    const rows = Array.from({ length: 1000 }, (_, index) => [{ name: `UiComponent${index}` }, `Component ${index}`] as any)
    const index = createComponentSuggestionIndex(rows, 'Ui')

    expect(index.get('UiComponent999')?.name).toBe('UiComponent999')
    expect(index.get('Component999')?.name).toBe('UiComponent999')
  })

  it('normalizes object suggestions in snippets and documentation', async () => {
    const { componentsReducer } = await import('../../src/ui/utils')
    const parent = { name: 'Parent', suggestions: [{ name: 'Child', description: 'Child component', description_zh: '子组件' }] }
    const child = { name: 'Child' }
    const [config] = componentsReducer({
      lib: 'fixture-lib',
      map: [[parent, 'Parent detail'], [child, 'Child detail']] as any,
    })

    const completions = await Promise.all(config.data(undefined, {
      languageId: 'vue',
      framework: 'vue',
      uri: 'file:///workspace/A.vue',
      version: 3,
    }))
    const parentCompletion = completions[0] as any

    expect(parentCompletion.params.document).toEqual({ uri: 'file:///workspace/A.vue', version: 3 })
    expect(parentCompletion.snippet).toContain('<child')
    expect(parentCompletion.snippet).not.toContain('[object Object]')
    expect(parentCompletion.documentation.value).toContain('- Child')
    expect(parentCompletion.documentation.value).not.toContain('[object Object]')
  })

  it('computes required props once for resolved suggestion children', async () => {
    const { componentsReducer } = await import('../../src/ui/utils')
    const parent = { name: 'Parent', suggestions: ['Child'], props: { parentProp: { required: true, type: 'string' } } }
    const child = { name: 'Child', props: { childProp: { required: true, type: 'string' } } }
    const [config] = componentsReducer({ lib: 'fixture-lib', map: [[parent, 'Parent'], [child, 'Child']] as any })
    const [completion] = await Promise.all(config.data()) as any[]

    expect(completion.snippet.match(/childProp=/g)).toHaveLength(1)
    const tabStops = [...completion.snippet.matchAll(/\$\{?(\d+)/g)].map(match => Number(match[1]))
    expect(new Set(tabStops)).toEqual(new Set(Array.from({ length: Math.max(...tabStops) }, (_, index) => index + 1)))
  })

  it('keeps snippet tab stops for missing, invalid, and circular suggestions', async () => {
    const { componentsReducer } = await import('../../src/ui/utils')
    const cases = [
      { name: 'MissingParent', suggestions: [{ name: 'Unknown' }] },
      { name: 'InvalidParent', suggestions: [{ name: '' }] },
      { name: 'CircularParent', suggestions: [{ name: 'CircularParent' }] },
    ]
    const [config] = componentsReducer({
      lib: 'fixture-lib',
      map: cases.map(component => [component, component.name]) as any,
    })

    const completions = await Promise.all(config.data()) as any[]
    for (const completion of completions) {
      expect(completion.snippet).toMatch(/\$\d+/)
      expect(completion.snippet).not.toContain('[object Object]')
    }
    expect(completions[0].snippet).not.toContain('<unknown1>')
  })

  it('normalizes required prop types and defaults without rejecting snippets', async () => {
    const { getRequireProp } = await import('../../src/ui/utils')

    await expect(getRequireProp({ props: { label: { required: true, default: '' } } }, 0, 'vue')).resolves.toEqual([
      ['label="${1||}"'],
      1,
    ])
    await expect(getRequireProp({ props: { count: { required: true, type: '0 | 1', default: 1 } } }, 0, 'vue')).resolves.toEqual([
      ['count="${1|1,0|}"'],
      1,
    ])
    await expect(getRequireProp({ props: { disabled: { required: true, type: 'boolean', default: false } } }, 0, 'react')).resolves.toEqual([
      ['disabled={true}'],
      0,
    ])
  })

  it('normalizes string component entries for every provider branch', async () => {
    const { componentsReducer } = await import('../../src/ui/utils')
    const context = { languageId: 'vue', framework: 'vue', uri: 'file:///Demo.vue', version: 1 } as const
    const prefixed = componentsReducer({ lib: 'ui', prefix: 'El', map: [['ElButton', 'Button']] as any })
    const direct = componentsReducer({ lib: 'ui', isReact: true, map: [['Button', 'Button']] as any })

    for (const provider of [...prefixed, ...direct]) {
      const [item] = await Promise.all(provider.data(undefined, context as any)) as any[]
      expect(item.params.data.name).toBe(provider.prefix ? 'ElButton' : provider.isReact ? 'Button' : 'Button')
    }
  })

  it('resolves related prop snippets from the current parent chain', async () => {
    const { propsReducer } = await import('../../src/ui/utils')
    const result = await propsReducer({
      uiName: 'fixture',
      lib: 'fixture-lib',
      prefix: 'el',
      map: [{
        name: 'Child',
        props: {
          ':value': {
            type: 'string',
            related: ['Missing.code', 'Parent.code'],
            $code: '$code.child',
          },
        },
      }] as any,
    })
    const parent = {
      tag: 'Parent',
      props: [{ name: 'bind', arg: { content: 'code' }, exp: { content: 'model' } }],
    }
    const completions = result.Child.completions[0]({ languageId: 'vue', framework: 'vue', uri: 'file:///Demo.vue', parent })
    expect(completions.find(item => item.content === ':value')?.snippet).toBe(':value="model.child"')
  })

  it('ignores malformed related metadata and incomplete parent props', async () => {
    const { propsReducer } = await import('../../src/ui/utils')
    const result = await propsReducer({
      uiName: 'fixture',
      lib: 'fixture-lib',
      map: [{
        name: 'Child',
        props: {
          ':value': { type: 'string', related: [42, 'Parent.code'] },
        },
      }] as any,
    })

    for (const props of [
      [{ name: 'bind', arg: { content: 'code' } }],
      [{ name: 'code' }],
      undefined,
    ]) {
      expect(() => result.Child.completions[0]({
        languageId: 'vue',
        framework: 'vue',
        uri: 'file:///Demo.vue',
        parent: { tag: 'Parent', props },
      })).not.toThrow()
    }
  })

  it('componentsReducer uses item-local dynamicLib/importWay without enabling HTML markdown', async () => {
    const { componentsReducer } = await import('../../src/ui/utils')

    const [config] = componentsReducer({
      lib: 'fixture-lib',
      dynamicLib: 'global-${name}',
      importWay: 'specifier',
      map: [
        [{ name: 'AlphaCard', description: 'Alpha', dynamicLib: '@alpha/${name}', importWay: 'default' }, 'Alpha detail'],
        [{ name: 'BetaCard', description: 'Beta' }, 'Beta detail'],
      ] as any,
    })

    const completions = await Promise.all(config.data())

    expect((completions[0] as any).params).toMatchObject({ dynamicLib: '@alpha/${name}', importWay: 'default' })
    expect((completions[1] as any).params).toMatchObject({ dynamicLib: 'global-${name}', importWay: 'specifier' })

    const firstDocumentation = completions[0].documentation as any
    expect(firstDocumentation.isTrusted).toEqual({
      enabledCommands: [
        'intellisense.openDocument',
        'intellisense.openDocumentExternal',
        'intellisense.copyDemo',
      ],
    })
    expect(firstDocumentation.supportHtml).toBe(false)
    expect(firstDocumentation.value).toContain('[Copy](command:intellisense.copyDemo?encoded:<AlphaCard$1>$2</AlphaCard>)')
  })
})
