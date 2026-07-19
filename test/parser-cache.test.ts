import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  vueParseMock,
  tsParseMock,
  compileVineTypeScriptFileMock,
  createCompilerCtxMock,
} = vi.hoisted(() => {
  return {
    vueParseMock: vi.fn((code: string) => ({
      descriptor: {
        template: null,
        script: null,
        scriptSetup: null,
      },
      errors: [],
      code,
    })),
    tsParseMock: vi.fn(() => ({
      body: [],
    })),
    compileVineTypeScriptFileMock: vi.fn(() => ({
      vineCompFns: [],
    })),
    createCompilerCtxMock: vi.fn(() => ({})),
  }
})

vi.mock('@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js', () => ({
  parse: vueParseMock,
}))

vi.mock('@typescript-eslint/typescript-estree', () => ({
  parse: tsParseMock,
}))

vi.mock('@vue-vine/compiler', () => ({
  compileVineTypeScriptFile: compileVineTypeScriptFileMock,
  createCompilerCtx: createCompilerCtxMock,
}))

describe('parser cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vueParseMock.mockClear()
    tsParseMock.mockClear()
    compileVineTypeScriptFileMock.mockClear()
    createCompilerCtxMock.mockClear()
  })

  it('reuses vue sfc parse result for unchanged code', async () => {
    const mod = await import('../src/parser')
    const pos = { line: 0, character: 0 } as any
    mod.transformVue('<template></template>', pos)
    mod.transformVue('<template></template>', pos)
    expect(vueParseMock).toHaveBeenCalledTimes(1)

    mod.transformVue('<template><div /></template>', pos)
    mod.transformVue('<template></template>', pos)
    expect(vueParseMock).toHaveBeenCalledTimes(2)
  })

  it('reuses jsx ast for unchanged code', async () => {
    const mod = await import('../src/parser')
    const pos = { line: 0, character: 0 } as any
    mod.parserJSX('const a = 1', pos)
    mod.parserJSX('const a = 1', pos)
    expect(tsParseMock).toHaveBeenCalledTimes(1)

    mod.parserJSX('const b = 2', pos)
    mod.parserJSX('const a = 1', pos)
    expect(tsParseMock).toHaveBeenCalledTimes(2)
  })

  it('does not mutate a cached JSX AST while deriving parser context', async () => {
    const ast: any = {
      body: [{
        type: 'JSXElement',
        range: [0, 27],
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 27 } },
        openingElement: {
          name: { type: 'JSXIdentifier', name: 'Button' },
          range: [0, 27],
          loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 27 } },
          attributes: [{ type: 'JSXAttribute', name: { name: 'disabled' }, value: null, range: [8, 16] }],
        },
        children: [],
      }],
    }
    const snapshot = structuredClone(ast)
    tsParseMock.mockReturnValue(ast)
    const mod = await import('../src/parser')

    mod.parserJSX('<Button disabled></Button>', { line: 0, character: 12 } as any)
    mod.parserJSX('<Button disabled></Button>', { line: 0, character: 12 } as any)

    expect(ast).toEqual(snapshot)
    expect(() => JSON.stringify(ast)).not.toThrow()
  })

  it('reuses vine compile result for unchanged code', async () => {
    const mod = await import('../src/parser')
    mod.createVineFileCtx('comp.ts', 'function App(){}')
    mod.createVineFileCtx('comp.ts', 'function App(){}')
    expect(compileVineTypeScriptFileMock).toHaveBeenCalledTimes(1)

    mod.createVineFileCtx('comp.ts', 'function Next(){}')
    expect(compileVineTypeScriptFileMock).toHaveBeenCalledTimes(2)
  })
})
