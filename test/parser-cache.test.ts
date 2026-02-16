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
    expect(vueParseMock).toHaveBeenCalledTimes(2)
  })

  it('reuses jsx ast for unchanged code', async () => {
    const mod = await import('../src/parser')
    const pos = { line: 0, character: 0 } as any
    mod.parserJSX('const a = 1', pos)
    mod.parserJSX('const a = 1', pos)
    expect(tsParseMock).toHaveBeenCalledTimes(1)

    mod.parserJSX('const b = 2', pos)
    expect(tsParseMock).toHaveBeenCalledTimes(2)
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
