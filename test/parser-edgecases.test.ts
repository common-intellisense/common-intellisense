import { describe, expect, it, vi } from 'vitest'

const { vueParseMock, tsParseMock } = vi.hoisted(() => ({
  vueParseMock: vi.fn(),
  tsParseMock: vi.fn(),
}))

vi.mock('@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js', () => ({
  parse: vueParseMock,
}))

vi.mock('@typescript-eslint/typescript-estree', () => ({
  parse: tsParseMock,
}))

vi.mock('@vue-vine/compiler', () => ({
  compileVineTypeScriptFile: vi.fn(),
  createCompilerCtx: vi.fn(),
}))

describe('parser edge cases', () => {
  it('does not crash on return without argument', async () => {
    tsParseMock.mockReturnValue({
      body: [{
        type: 'ReturnStatement',
        argument: null,
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 7 } },
      }],
    })
    const mod = await import('../src/parser')
    expect(() => mod.parserJSX('return;', { line: 1, character: 2 } as any)).not.toThrow()
  })

  it('uses the supplied document context instead of the active editor path', async () => {
    tsParseMock.mockReturnValue({ body: [] })
    const mod = await import('../src/parser')
    expect(mod.parser('const value = 1', { line: 1, character: 2 } as any, {
      languageId: 'typescriptreact',
      uri: 'file:///workspace/Component.tsx',
    })).toMatchObject({ type: 'script' })
  })

  it('does not crash when jsx refs are absent', async () => {
    tsParseMock.mockReturnValue({ body: [] })
    const mod = await import('../src/parser')
    expect(() => mod.getReactRefsMap()).not.toThrow()
  })

  it('ignores a boolean JSX ref attribute without throwing', async () => {
    tsParseMock.mockReturnValue({
      body: [{
        type: 'JSXElement',
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
        children: [],
        openingElement: {
          name: { name: 'Button' },
          attributes: [{ name: { name: 'ref' }, value: null }],
        },
      }],
    })
    const mod = await import('../src/parser')
    expect(() => mod.parserJSX('<Button ref />', { line: 1, character: 2 } as any)).not.toThrow()
  })

  it('handles JSX spread attributes without aborting the parser', async () => {
    tsParseMock.mockReturnValue({
      body: [{
        type: 'JSXElement',
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 27 } },
        children: [],
        openingElement: {
          name: { type: 'JSXIdentifier', name: 'Button' },
          loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 40 } },
          attributes: [{
            type: 'JSXSpreadAttribute',
            loc: { start: { line: 1, column: 8 }, end: { line: 1, column: 24 } },
            argument: { type: 'Identifier', name: 'buttonProps' },
          }],
        },
      }],
    })
    const mod = await import('../src/parser')
    expect(mod.parserJSX('<Button {...buttonProps} />', { line: 0, character: 12 } as any)).toMatchObject({
      type: 'props',
      tag: 'Button',
      propType: 'JSXSpreadAttribute',
    })
  })

  it('maps refs on JSX compound components without throwing', async () => {
    tsParseMock.mockReturnValue({
      body: [{
        type: 'JSXElement',
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 34 } },
        children: [],
        openingElement: {
          name: {
            type: 'JSXMemberExpression',
            object: { type: 'JSXIdentifier', name: 'Modal' },
            property: { type: 'JSXIdentifier', name: 'Header' },
          },
          loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 40 } },
          attributes: [{
            type: 'JSXAttribute',
            name: { type: 'JSXIdentifier', name: 'ref' },
            value: { type: 'JSXExpressionContainer', expression: { type: 'Identifier', name: 'headerRef' } },
            loc: { start: { line: 1, column: 14 }, end: { line: 1, column: 29 } },
          }],
        },
      }],
    })
    const mod = await import('../src/parser')
    const result = mod.parserJSX('<Modal.Header ref={headerRef} />', { line: 0, character: 20 } as any)
    expect(result).toBeDefined()
    expect(result?.refsMap).toEqual({ headerRef: 'Modal.Header' })
  })

  it('falls back safely for unterminated vue tags in attribute checks', async () => {
    const mod = await import('../src/parser')
    const child = {
      tag: 'Comp',
      props: [],
      loc: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 15, offset: 14 },
        source: '<Comp foo="bar"',
      },
      isSelfClosing: false,
      children: [],
    }
    const result = mod.isInAttribute(child, { line: 1, character: 6 } as any, 0)
    expect(result).toBeTypeOf('boolean')
  })
})
