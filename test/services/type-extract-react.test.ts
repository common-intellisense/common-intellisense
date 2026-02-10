import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

vi.mock('../../src/ui/utils', () => ({
  componentsReducer: (opts: any) => opts.map,
  propsReducer: (opts: any) => opts.map,
  hyphenate: (s: string) => s.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''),
  toCamel: (s: string) => s.replace(/-(\w)/g, (_: string, v: string) => v.toUpperCase()),
}))

describe('type extract fallback (react types)', () => {
  let tempRoot = ''
  let prevCwd = ''

  beforeAll(async () => {
    prevCwd = process.cwd()
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-type-extract-react-'))
    await fsp.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'tmp-root' }))
    const pkgRoot = path.join(tempRoot, 'node_modules', 'mock-react-ui')
    await fsp.mkdir(pkgRoot, { recursive: true })
    await fsp.writeFile(path.join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'mock-react-ui',
      version: '1.0.0',
      types: 'index.d.ts',
    }))
    await fsp.writeFile(path.join(pkgRoot, 'index.d.ts'), `
declare const _ButtonTypes: readonly ["default", "primary"]
export type ButtonType = (typeof _ButtonTypes)[number]

type TargetBase = '_self' | '_blank' | '_parent' | '_top'
type TargetAlias = TargetBase

export interface InputProps$1 {
  value?: string
}

export interface ButtonProps {
  type?: ButtonType
  target?: TargetAlias | string
  inputProps?: InputProps$1
  inputValue?: InputProps$1['value']
  onClick?: (event: MouseEvent) => void
}

export type FC<P = {}> = (props: P) => any
export declare const Button: FC<ButtonProps>
`)
    process.chdir(tempRoot)
  })

  afterAll(async () => {
    process.chdir(prevCwd)
    if (tempRoot)
      await fsp.rm(tempRoot, { recursive: true, force: true })
  })

  it('extracts props and expands type aliases', async () => {
    const mod = await import('../../src/type-extract')
    const result = await mod.fetchFromTypes({ pkgName: 'mock-react-ui', uiName: 'mockReact1' })
    expect(result).toBeDefined()

    const components = result!.mockReact1Components()
    const button = components.find((entry: any) => entry[0].name === 'Button')?.[0]
    expect(button).toBeDefined()

    expect(button.props.type.value).toEqual(['default', 'primary'])
    expect(button.props.type.type).toContain('default')
    expect(button.props.target.type).toContain('_self')
    expect(button.props.target.type).toContain('string')
    expect(Array.isArray(button.props.target.value)).toBe(true)
    expect(button.props.target.value).toEqual(expect.arrayContaining(['_self', '_blank', '_parent', '_top']))
    expect(button.props.inputProps.type).toContain('InputProps')
    expect(button.props.inputProps.type).not.toContain('$')
    const detail = button.props.inputProps.typeDetail
    expect(detail).toBeDefined()
    expect(detail?.InputProps).toBeDefined()
    expect(detail?.InputProps?.some((item: any) => item.name === 'value')).toBe(true)
    expect(button.props.inputValue.type).toContain('string')
    expect(button.props.inputValue.type).not.toContain('InputProps')
  })
})
