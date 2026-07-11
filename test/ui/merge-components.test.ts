import { describe, expect, it } from 'vitest'
import { mergeComponents } from '../../src/ui/ui-find'

function provider(lib: string, prefix: string, id: string) {
  return { lib, prefix, data: () => id, directives: {} }
}

describe('component provider pair deduplication', () => {
  it('deduplicates exact lib/prefix pairs without dropping another library prefix', () => {
    const target: any = { prefix: [], data: [], directivesMap: {}, libs: [], providerKeys: new Set() }
    mergeComponents(target, [
      provider('A', 'a', 'Aa'),
      provider('A', '', 'A'),
      provider('B', 'b', 'Bb'),
      provider('B', '', 'B'),
      provider('B', '', 'duplicate'),
    ], {}, [], 'fixture')

    expect(target.data.map((item: any) => item())).toEqual(['Aa', 'A', 'Bb', 'B'])
    expect(target.providerKeys).toEqual(new Set(['A\0a', 'A\0', 'B\0b', 'B\0']))
  })
})
