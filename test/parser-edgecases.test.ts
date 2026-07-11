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
    tsParseMock.mockReturnValueOnce({
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
    tsParseMock.mockReturnValueOnce({ body: [] })
    const mod = await import('../src/parser')
    expect(mod.parser('const value = 1', { line: 1, character: 2 } as any, {
      languageId: 'typescriptreact',
      uri: 'file:///workspace/Component.tsx',
    })).toMatchObject({ type: 'script' })
  })

  it('does not crash when jsx refs are absent', async () => {
    tsParseMock.mockReturnValueOnce({ body: [] })
    const mod = await import('../src/parser')
    expect(() => mod.getReactRefsMap()).not.toThrow()
  })

  it('ignores a boolean JSX ref attribute without throwing', async () => {
    tsParseMock.mockReturnValueOnce({
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
