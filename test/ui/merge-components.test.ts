import { describe, expect, it } from 'vitest'
import { mergeComponents } from '../../src/ui/ui-find'
import { componentsReducer } from '../../src/ui/utils'

function provider(lib: string, prefix: string, id: string) {
  return { lib, prefix, data: () => id, directives: {} }
}

function target(): any {
  return { prefix: [], data: [], directivesMap: {}, libs: [], providerKeys: new Set<string>() }
}

describe('component provider source deduplication', () => {
  it('deduplicates an exact source/lib/prefix identity', () => {
    const value = target()
    mergeComponents(value, [
      provider('A', 'a', 'Aa'),
      provider('A', '', 'A'),
      provider('B', 'b', 'Bb'),
      provider('B', '', 'B'),
      provider('B', '', 'duplicate'),
    ], {}, [], 'fixture', 'official:fixture')

    expect(value.data.map((item: any) => item())).toEqual(['Aa', 'A', 'Bb', 'B'])
    expect(value.providerKeys).toEqual(new Set([
      'official:fixture\0A\0a',
      'official:fixture\0A\0',
      'official:fixture\0B\0b',
      'official:fixture\0B\0',
    ]))
  })

  it('associates directives with the exact adapter identity', () => {
    const value = target()
    const directives = [{ name: 'focus' }]
    mergeComponents(value, [{ ...provider('antd', 'a', 'Button'), directives }], {}, ['antd-mobile5', 'antd5'], 'antd5', 'official:antd5')

    expect(value.directivesMap.antd5).toBe(directives)
    expect(value.directivesMap['antd-mobile5']).toBeUndefined()
  })

  it.each([
    ['primevue', '', 'Button', 'p', 'p-button'],
    ['element-plus', 'El', 'ElButton', 'x', 'x-button'],
  ])('renders the configured template prefix for %s without changing import identity', async (lib, adapterPrefix, name, override, renderedTag) => {
    const value = target()
    const components = componentsReducer({ lib, prefix: adapterPrefix, map: [[{ name }, 'Button']] })
    mergeComponents(value, components, { [lib]: override }, [], 'fixture', 'official:fixture')
    const context = { languageId: 'vue', framework: 'vue', hostFramework: 'vue', syntax: 'template', uri: 'file:///App.vue' }
    const items = await Promise.all(value.data[0](undefined, context))
    const item = items[0] as any

    expect(item.snippet).toContain(`<${renderedTag}`)
    expect(item.snippet).toContain(`</${renderedTag}>`)
    expect(item.params.renderedTag).toBe(renderedTag)
    expect(item.params.data.name).toBe(name)
    expect(item.params.prefix).toBe(adapterPrefix)
  })

  it('applies the configured prefix to suggestion children', async () => {
    const value = target()
    const components = componentsReducer({
      lib: 'element-plus',
      prefix: 'El',
      map: [
        [{ name: 'ElSelect', suggestions: ['ElOption'] }, 'Select'],
        [{ name: 'ElOption' }, 'Option'],
      ],
    })
    mergeComponents(value, components, { 'element-plus': 'x' }, [], 'fixture', 'official:fixture')
    const context = { languageId: 'vue', framework: 'vue', hostFramework: 'vue', syntax: 'template', uri: 'file:///App.vue' }
    const items = await Promise.all(value.data[0](undefined, context))
    const select = items.find((item: any) => item.params.data.name === 'ElSelect') as any

    expect(select.snippet).toContain('<x-select')
    expect(select.snippet).toContain('<x-option')
    expect(select.snippet).toContain('</x-option>')
    expect(select.snippet).toContain('</x-select>')
    expect(select.params.renderedTag).toBe('x-select')
  })

  it('keeps different sources that contribute the same lib and prefix', () => {
    const value = target()
    mergeComponents(value, [provider('element-plus', 'el', 'ElButton')], {}, [], 'elementPlus2', 'official:elementPlus2')
    mergeComponents(value, [provider('element-plus', 'el', 'ElBusinessTable')], {}, [], 'Custom', 'custom:0:CustomComponents')

    expect(value.data.map((item: any) => item())).toEqual(['ElButton', 'ElBusinessTable'])
  })
})
