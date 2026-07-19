import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tsParseMock } = vi.hoisted(() => ({
  tsParseMock: vi.fn(() => {
    throw new Error('incomplete TSX')
  }),
}))

vi.mock('@typescript-eslint/typescript-estree', () => ({
  parse: tsParseMock,
}))

vi.mock('@vue-vine/compiler', () => ({
  compileVineTypeScriptFile: vi.fn(),
  createCompilerCtx: vi.fn(),
}))

describe('incomplete TSX parser fallback', () => {
  beforeEach(() => {
    tsParseMock.mockClear()
  })

  it('returns tag context for an incomplete opening element', async () => {
    const { parserJSX } = await import('../src/parser')
    const result = parserJSX('<Button ', { line: 0, character: 4 } as any)

    expect(result).toMatchObject({
      type: 'tag',
      tag: 'Button',
      props: [],
      isInTemplate: true,
      refsMap: {},
      refs: [],
    })
  })

  it('returns a compatible prop context for incomplete attributes', async () => {
    const { parserJSX } = await import('../src/parser')
    const result = parserJSX('<Button disabled', { line: 0, character: 16 } as any)

    expect(result).toMatchObject({
      type: 'props',
      tag: 'Button',
      propName: 'disabled',
      propType: 'JSXAttribute',
      isValue: false,
      isDynamicFlag: false,
      isEvent: false,
      isInTemplate: true,
      refsMap: {},
      refs: [],
    })
    expect(result?.props).toEqual([{
      type: 'JSXAttribute',
      name: { type: 'JSXIdentifier', name: 'disabled' },
      range: [8, 16],
    }])
  })

  it('recognizes an incomplete dynamic prop value after earlier syntax errors', async () => {
    const { parserJSX } = await import('../src/parser')
    const code = 'const broken = ;\n<Button value={'
    const result = parserJSX(code, { line: 1, character: 15 } as any)

    expect(result).toMatchObject({
      type: 'props',
      tag: 'Button',
      propName: 'value',
      propType: 'JSXAttribute',
      isValue: true,
      isDynamicFlag: true,
      isEvent: false,
    })
  })

  it('also handles complete JSX when the primary parser fails', async () => {
    const { parserJSX } = await import('../src/parser')
    const code = '<Button disabled />'

    expect(parserJSX(code, { line: 0, character: 4 } as any)).toMatchObject({
      type: 'tag',
      tag: 'Button',
    })
    expect(parserJSX(code, { line: 0, character: 12 } as any)).toMatchObject({
      type: 'props',
      tag: 'Button',
      propName: 'disabled',
    })
  })

  it('returns minimal spread attribute context', async () => {
    const { parserJSX } = await import('../src/parser')
    const code = '<Button {...props'
    const result = parserJSX(code, { line: 0, character: code.length } as any)

    expect(result).toMatchObject({
      type: 'props',
      tag: 'Button',
      propType: 'JSXSpreadAttribute',
      isValue: false,
      isDynamicFlag: false,
      isEvent: false,
    })
    expect(result?.propName).toBeUndefined()
    expect(result?.props).toEqual([{
      type: 'JSXSpreadAttribute',
      range: [8, code.length],
    }])
  })

  it('preserves member-expression tag names', async () => {
    const { parserJSX } = await import('../src/parser')
    const code = '<Modal.Header active'

    expect(parserJSX(code, { line: 0, character: code.length } as any)).toMatchObject({
      type: 'props',
      tag: 'Modal.Header',
      propName: 'active',
    })
  })

  it('chooses the innermost cursor-covering opening element', async () => {
    const { parserJSX } = await import('../src/parser')
    const code = '<Outer><Inner active'
    const result = parserJSX(code, { line: 0, character: code.length } as any)

    expect(result).toMatchObject({
      type: 'props',
      tag: 'Inner',
      propName: 'active',
    })
  })

  it('does not cache a failed primary parse or the fallback AST', async () => {
    const { parserJSX } = await import('../src/parser')
    const code = '<Button disabled'

    parserJSX(code, { line: 0, character: code.length } as any)
    parserJSX(code, { line: 0, character: code.length } as any)

    expect(tsParseMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['const result = left < right', 20],
    ['const text = "<Button disabled"', 23],
    ['// <Button disabled', 14],
  ])('does not treat non-JSX text as an opening element: %s', async (code, character) => {
    const { parserJSX } = await import('../src/parser')
    expect(parserJSX(code, { line: 0, character } as any)).toBeUndefined()
  })
})
