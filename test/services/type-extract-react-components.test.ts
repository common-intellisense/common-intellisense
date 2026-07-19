import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

describe('react type fallback component snippets', () => {
  let root = ''
  let previousCwd = ''

  beforeAll(async () => {
    previousCwd = process.cwd()
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-react-components-'))
    const packageRoot = path.join(root, 'node_modules', 'mock-react-components')
    await fsp.mkdir(packageRoot, { recursive: true })
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await fsp.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'mock-react-components',
      version: '1.0.0',
      types: 'index.d.ts',
    }))
    await fsp.writeFile(path.join(packageRoot, 'index.d.ts'), `
      export interface ButtonProps { disabled?: boolean }
      export type FC<P = {}> = (props: P) => any
      export declare const Button: FC<ButtonProps>
    `)
    process.chdir(root)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('preserves PascalCase tags and import command data', async () => {
    const { fetchFromTypes } = await import('../../src/type-extract')
    const exports = await fetchFromTypes({ pkgName: 'mock-react-components', uiName: 'mockReactComponents1' })
    const providers = exports!.mockReactComponents1Components()
    const items = await Promise.all(providers[0].data(undefined, {
      languageId: 'typescriptreact',
      hostFramework: 'react',
      syntax: 'jsx',
      framework: 'react',
      uri: 'file:///App.tsx',
      version: 1,
    }))
    const button = items.find((item: any) => item.params?.data?.name === 'Button') as any

    expect(button).toBeDefined()
    expect(button.snippet).toContain('<Button')
    expect(button.snippet).not.toContain('<button')
    expect(button.params.data.name).toBe('Button')
  })
})
