import { describe, expect, it } from 'vitest'
import { parse } from '@typescript-eslint/typescript-estree'
import { getNodeOffsetRange } from '../../src/services/node-range'

describe('node offset ranges', () => {
  it('uses ESTree range with a script block offset', () => {
    const code = 'const view = <Form.Item />'
    const ast = parse(code, { jsx: true, loc: true, range: true }) as any
    const element = ast.body[0].declarations[0].init
    expect(getNodeOffsetRange(element, 100)).toEqual({
      start: code.indexOf('<') + 100,
      end: code.length + 100,
    })
  })

  it('uses Vue compiler offsets when no ESTree range exists', () => {
    expect(getNodeOffsetRange({ loc: { start: { offset: 4 }, end: { offset: 12 } } })).toEqual({ start: 4, end: 12 })
  })
})
