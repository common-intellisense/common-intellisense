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
