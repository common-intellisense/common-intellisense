import { describe, expect, it } from 'vitest'
import { mergeComponents } from '../../src/ui/ui-find'

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

  it('keeps different sources that contribute the same lib and prefix', () => {
    const value = target()
    mergeComponents(value, [provider('element-plus', 'el', 'ElButton')], {}, [], 'elementPlus2', 'official:elementPlus2')
    mergeComponents(value, [provider('element-plus', 'el', 'ElBusinessTable')], {}, [], 'Custom', 'custom:0:CustomComponents')

    expect(value.data.map((item: any) => item())).toEqual(['ElButton', 'ElBusinessTable'])
  })
})
