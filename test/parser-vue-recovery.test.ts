import { describe, expect, it } from 'vitest'
import { parser } from '../src/parser'

describe('vue parser recovery', () => {
  it('uses a recoverable compiler-sfc AST for an incomplete component tag', () => {
    const code = '<template><Comp foo="bar">'
    const character = code.indexOf('foo') + 2
    expect(parser(code, { line: 0, character } as any, {
      languageId: 'vue',
      uri: 'file:///App.vue',
      offset: character,
    })).toMatchObject({ type: 'props', tag: 'Comp', propName: 'foo' })
  })

  it('marks dynamic directive arguments for safe value completion', () => {
    const code = '<template><Comp :[foo.bar]="value" /></template>'
    const character = code.indexOf('value') + 2
    expect(parser(code, { line: 0, character } as any, {
      languageId: 'vue',
      uri: 'file:///App.vue',
      offset: character,
    })).toMatchObject({ type: 'props', isDynamicArgument: true })
  })

  it('does not throw when compiler-sfc cannot recover a useful tag', () => {
    const code = '<template>\n<Comp foo="bar"'
    expect(() => parser(code, { line: 1, character: 8 } as any, {
      languageId: 'vue',
      uri: 'file:///App.vue',
      offset: code.length - 3,
    })).not.toThrow()
  })
})
