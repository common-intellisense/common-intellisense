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
    expect(props.Demo.completions[0](svelteContext).some(item => item.content === 'className')).toBe(true)

    const [components] = componentsReducer({ lib: 'fixture-lib', map: [[{ name: 'Demo' }, 'Demo']] as any })
    const react = await Promise.all(components.data(undefined, { languageId: 'typescriptreact', framework: 'react', uri: 'file:///Demo.tsx' }))
    expect((react[0] as any).snippet).toContain('<demo')
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
    expect(firstDocumentation.value).toContain('[Copy](command:intellisense.copyDemo?encoded:<alpha-card$1>$2</alpha-card>)')
  })
})
