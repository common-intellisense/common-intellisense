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

describe('type extract fallback (local types)', () => {
  let tempRoot = ''
  let prevCwd = ''

  beforeAll(async () => {
    prevCwd = process.cwd()
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-type-extract-'))
    await fsp.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'tmp-root' }))
    const pkgRoot = path.join(tempRoot, 'node_modules', 'mock-ui')
    await fsp.mkdir(pkgRoot, { recursive: true })
    await fsp.writeFile(path.join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'mock-ui',
      version: '1.0.0',
    }))
    await fsp.writeFile(path.join(pkgRoot, 'global.d.ts'), `
declare module 'vue' {
  export interface GlobalComponents {
    FooButton: typeof import('./foo').FooButton
    'bar-input': typeof import('./foo').BarInput
    BazCard: typeof import('./foo').BazCard
  }
}
export {}
`)
    await fsp.writeFile(path.join(pkgRoot, 'foo.d.ts'), `
export type DefineSetupFnComponent<P, E> = {
  __props?: P
  __emits?: E
}
export interface SimpleComponent {
  __propDef: {
    props: {
      size?: 'sm' | 'md'
      disabled?: boolean
      count: number
    }
    emits: {
      change: (value: number) => void
      'update:modelValue': (value: string) => void
    }
  }
}
export declare const FooButton: SimpleComponent
export declare const BarInput: SimpleComponent
export interface BazProps {
  title?: string
  count: number
}
export interface BazEmits {
  update: (value: string) => void
}
export declare const BazCard: DefineSetupFnComponent<BazProps, BazEmits>
`)

    const omitRoot = path.join(tempRoot, 'node_modules', 'mock-ui-omit')
    await fsp.mkdir(omitRoot, { recursive: true })
    await fsp.writeFile(path.join(omitRoot, 'package.json'), JSON.stringify({
      name: 'mock-ui-omit',
      version: '1.0.0',
      types: 'index.d.ts',
    }))
    await fsp.writeFile(path.join(omitRoot, 'Select.d.ts'), `
export interface BaseOptionType {
  disabled?: boolean
  className?: string
  title?: string
  [name: string]: any
}
export interface DefaultOptionType extends BaseOptionType {
  value?: string | number | null
  label?: string
  children?: Omit<DefaultOptionType, 'children'>[]
}
`)
    await fsp.writeFile(path.join(omitRoot, 'Option.d.ts'), `
import { DefaultOptionType } from './Select.tsx'
export interface OptionProps extends Omit<DefaultOptionType, 'label'> {
  [prop: string]: any
}
`)
    await fsp.writeFile(path.join(omitRoot, 'index.d.ts'), `
import type { OptionProps } from './Option.js'
export declare const SelectOption: (props: OptionProps) => any
`)
    const exportsRoot = path.join(tempRoot, 'node_modules', 'mock-exports-ui')
    await fsp.mkdir(exportsRoot, { recursive: true })
    await fsp.writeFile(path.join(exportsRoot, 'package.json'), JSON.stringify({
      name: 'mock-exports-ui',
      version: '1.0.0',
      types: './index.d.ts',
      exports: { '.': { types: './index.d.ts' } },
    }))
    await fsp.writeFile(path.join(exportsRoot, 'index.d.ts'), `
export interface ExportButtonProps { disabled?: boolean }
export declare const ExportButton: (props: ExportButtonProps) => any
`)
    const lateGlobalRoot = path.join(tempRoot, 'node_modules', 'mock-late-global')
    await fsp.mkdir(lateGlobalRoot, { recursive: true })
    await fsp.writeFile(path.join(lateGlobalRoot, 'package.json'), JSON.stringify({
      name: 'mock-late-global',
      version: '1.0.0',
      types: 'index.d.ts',
    }))
    await fsp.writeFile(path.join(lateGlobalRoot, 'index.d.ts'), `
export interface InitialProps { value?: string }
export declare const InitialButton: (props: InitialProps) => any
`)
    process.chdir(tempRoot)
  })

  afterAll(async () => {
    process.chdir(prevCwd)
    if (tempRoot)
      await fsp.rm(tempRoot, { recursive: true, force: true })
  })

  it('extracts components and props from GlobalComponents', async () => {
    const mod = await import('../../src/type-extract')
    const result = await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'mockUi1' })
    expect(result).toBeDefined()

    const components = result!.mockUi1Components()
    expect(Array.isArray(components)).toBe(true)
    const names = components.map((entry: any) => entry[0].name)
    expect(names).toContain('FooButton')
    expect(names).toContain('BarInput')

    const foo = components.find((entry: any) => entry[0].name === 'FooButton')?.[0]
    expect(foo).toBeDefined()
    expect(foo.props.size.value).toEqual(['sm', 'md'])
    expect(foo.props.count.required).toBe(true)
    const events = foo.events.map((event: any) => event.name)
    expect(events).toContain('change')
    expect(events).toContain('update:modelValue')
    const change = foo.events.find((event: any) => event.name === 'change')
    expect(change?.params).toContain('number')

    const baz = components.find((entry: any) => entry[0].name === 'BazCard')?.[0]
    expect(baz).toBeDefined()
    expect(baz.props.count.required).toBe(true)
    const bazEvents = baz.events.map((event: any) => event.name)
    expect(bazEvents).toContain('update')
  })

  it('keeps uiName projections isolated for the same package', async () => {
    const mod = await import('../../src/type-extract')
    const first = await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'firstUi' })
    const second = await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'secondUi' })
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    expect(Object.keys(first!)).toEqual(expect.arrayContaining(['firstUiComponents', 'firstUi', 'firstUiRaw']))
    expect(Object.keys(second!)).toEqual(expect.arrayContaining(['secondUiComponents', 'secondUi', 'secondUiRaw']))
  })

  it('refreshes the cache when the source entry changes', async () => {
    const mod = await import('../../src/type-extract')
    const pkgRoot = path.join(tempRoot, 'node_modules', 'mock-ui')
    const entry = path.join(pkgRoot, 'foo.d.ts')
    const initial = await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'refreshUi' })
    const initialComponents = initial!.refreshUiComponents()
    const before = initialComponents.find((entry: any) => entry[0].name === 'FooButton')?.[0]?.props?.size?.value
    await fsp.writeFile(entry, `
export type DefineSetupFnComponent<P, E> = {
  __props?: P
  __emits?: E
}
export interface SimpleComponent {
  __propDef: {
    props: {
      size?: 'sm' | 'lg'
      disabled?: boolean
      count: number
    }
    emits: {
      change: (value: number) => void
      'update:modelValue': (value: string) => void
    }
  }
}
export declare const FooButton: SimpleComponent
export declare const BarInput: SimpleComponent
export interface BazProps {
  title?: string
  count: number
}
export interface BazEmits {
  update: (value: string) => void
}
export declare const BazCard: DefineSetupFnComponent<BazProps, BazEmits>
`)
    await fsp.utimes(entry, new Date(), new Date())
    await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'refreshUi' })
    const refreshed = await import('../../src/type-extract')
    const refreshedComponents = refreshed.fetchFromTypes ? (await refreshed.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'refreshUi' }))!.refreshUiComponents() : []
    const after = refreshedComponents.find((entry: any) => entry[0].name === 'FooButton')?.[0]?.props?.size?.value
    expect(before).toEqual(['sm', 'md'])
    expect(after).toEqual(['sm', 'lg'])
  })

  it('refreshes the cache when a previously missing global declaration is created', async () => {
    const mod = await import('../../src/type-extract')
    const pkgRoot = path.join(tempRoot, 'node_modules', 'mock-late-global')
    const initial = await mod.fetchFromTypes({ pkgName: 'mock-late-global', uiName: 'lateGlobalUi' })
    expect(initial!.lateGlobalUiComponents().map((entry: any) => entry[0].name)).not.toContain('LaterButton')

    await fsp.writeFile(path.join(pkgRoot, 'late.d.ts'), `
export interface LaterProps { disabled?: boolean }
export declare const LaterButton: (props: LaterProps) => any
`)
    await fsp.writeFile(path.join(pkgRoot, 'global.d.ts'), `
declare module 'vue' {
  export interface GlobalComponents {
    LaterButton: typeof import('./late').LaterButton
  }
}
export {}
`)

    const refreshed = await mod.fetchFromTypes({ pkgName: 'mock-late-global', uiName: 'lateGlobalUi' })
    expect(refreshed!.lateGlobalUiComponents().map((entry: any) => entry[0].name)).toContain('LaterButton')
  })

  it('does not recursively scan declaration directories on cache hits', async () => {
    const readdirSpy = vi.spyOn(fsp, 'readdir')
    const mod = await import('../../src/type-extract')
    await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'scanUi' })
    readdirSpy.mockClear()

    await mod.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'scanUi' })
    expect(readdirSpy).not.toHaveBeenCalled()
    readdirSpy.mockRestore()
  })

  it('deduplicates concurrent requests for the same cache key', async () => {
    await import('../../src/type-extract')
    const fresh = await import('../../src/type-extract')
    const [first, second] = await Promise.all([
      fresh.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'concurrentUi' }),
      fresh.fetchFromTypes({ pkgName: 'mock-ui', uiName: 'concurrentUi' }),
    ])
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).toBe(second)
  })

  it('extracts types when package exports do not expose package.json', async () => {
    const mod = await import('../../src/type-extract')
    const result = await mod.fetchFromTypes({ pkgName: 'mock-exports-ui', uiName: 'mockExports1' })

    expect(result).toBeDefined()
    expect(result!.mockExports1Components().map((entry: any) => entry[0].name)).toContain('ExportButton')
  })

  it('resolves fallback module extensions for option props', async () => {
    const mod = await import('../../src/type-extract')
    const result = await mod.fetchFromTypes({ pkgName: 'mock-ui-omit', uiName: 'mockUiOmit1' })
    expect(result).toBeDefined()

    const components = result!.mockUiOmit1Components()
    const option = components.find((entry: any) => entry[0].name === 'SelectOption')?.[0]
    expect(option).toBeDefined()
    expect(option.props.value).toBeDefined()
    expect(option.props.value.type).toContain('string')
    expect(option.props.value.type).toContain('number')
    expect(option.props.value.type).toContain('null')
    expect(option.props.label).toBeUndefined()
    expect(option.props.children.type).toContain('{')
    expect(option.props.children.type).toContain('}[]')
    expect(option.props.children.type).toContain('value?: string | number | null')
    expect(option.props.children.type).toContain('disabled?: boolean')
    expect(option.props.children.type).toContain('className?: string')
    expect(option.props.children.type).toContain('title?: string')
    expect(option.props.children.type).not.toContain('Omit<')
  })
})
