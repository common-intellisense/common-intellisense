import { describe, expect, it } from 'vitest'
import { createImportEdits, getSuggestedImportNames, isSafeBindingIdentifier, resolveImportSource } from '../../src/services/imports'

function applyEdits(code: string, edits: ReturnType<typeof createImportEdits>) {
  return [...edits].sort((a, b) => b.start - a.start).reduce(
    (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
    code,
  )
}

describe('import transforms', () => {
  it('accepts binding identifiers but rejects JavaScript keywords', () => {
    expect(isSafeBindingIdentifier('$Button')).toBe(true)
    expect(isSafeBindingIdentifier('按钮')).toBe(true)
    for (const keyword of ['class', 'default', 'enum', 'await', 'yield', 'implements']) {
      expect(isSafeBindingIdentifier(keyword)).toBe(false)
      expect(createImportEdits('', 'ui', [keyword])).toEqual([])
    }
  })

  it('prefers an explicit component source over a dynamic source', () => {
    expect(resolveImportSource('@custom/button', '@fallback/${name}', 'ui', 'Button', name => name.toLowerCase())).toBe('@custom/button')
    expect(resolveImportSource(undefined, '@fallback/${name}', 'ui', 'Button', name => name.toLowerCase())).toBe('@fallback/button')
    expect(resolveImportSource(undefined, undefined, 'ui', 'Button', name => name)).toBe('ui')
  })

  it('accepts object suggestions without throwing', () => {
    expect(getSuggestedImportNames([{ name: 'Menu.Item' }], '')).toEqual(['Menu'])
    expect(getSuggestedImportNames([{ description: 'missing name' }], '')).toEqual([])
  })

  it('imports suggestions only for named-specifier mode', () => {
    const suggestions = [{ name: 'Child' }]
    expect(getSuggestedImportNames(suggestions, '', 'specifier')).toEqual(['Child'])
    expect(getSuggestedImportNames(suggestions, '', 'default')).toEqual([])
    expect(getSuggestedImportNames(suggestions, '', 'as default')).toEqual([])

    const dynamicSource = resolveImportSource(undefined, '@ui/${name}', 'ui', 'Parent', name => name.toLowerCase())
    const defaultOutput = applyEdits('', createImportEdits('', dynamicSource, [...getSuggestedImportNames(suggestions, '', 'default'), 'Parent'], 'default'))
    const namespaceOutput = applyEdits('', createImportEdits('', dynamicSource, [...getSuggestedImportNames(suggestions, '', 'as default'), 'Parent'], 'as default'))
    const specifierOutput = applyEdits('', createImportEdits('', dynamicSource, [...getSuggestedImportNames(suggestions, '', 'specifier'), 'Parent'], 'specifier'))

    expect(defaultOutput).toBe('import Parent from "@ui/parent"\n')
    expect(namespaceOutput).toBe('import * as Parent from "@ui/parent"\n')
    expect(specifierOutput).toBe('import { Child, Parent } from "@ui/parent"\n')
  })

  it('adds named imports without modifying type-only imports', () => {
    const code = `import type { ButtonProps } from "ui"\nimport DefaultThing, { Existing as Alias } from "ui"\nconst value = 1\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button', 'Alias'], 'specifier'))
    expect(output).toContain('import type { ButtonProps } from "ui"')
    expect(output).toContain('import DefaultThing, { Existing as Alias, Button } from "ui"')
  })

  it('adds bindings to empty named imports', () => {
    const singleLine = `import {} from 'ui'\n`
    const multiline = `import {\n} from 'ui'\n`

    expect(applyEdits(singleLine, createImportEdits(singleLine, 'ui', ['Input'], 'specifier'))).toBe(`import { Input } from 'ui'\n`)
    expect(applyEdits(multiline, createImportEdits(multiline, 'ui', ['Input'], 'specifier'))).toBe(`import {\n  Input,\n} from 'ui'\n`)
  })

  it('preserves multiline named-import comments and formatting when adding bindings', () => {
    const code = `import {
  // required for compatibility
  Button,
} from 'ui'
`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Input'], 'specifier'))

    expect(output).toBe(`import {
  // required for compatibility
  Button,
  Input,
} from 'ui'
`)
  })

  it('keeps trailing line comments attached to the existing binding', () => {
    const code = `import {
  Button // primary control
} from 'ui'
`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Input'], 'specifier'))

    expect(output).toBe(`import {
  Button, // primary control
  Input,
} from 'ui'
`)
  })

  it('preserves mixed-import aliases and block comments when adding bindings', () => {
    const code = `import DefaultThing, { Existing as Alias /* keep */ } from 'ui';\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button'], 'specifier'))

    expect(output).toBe(`import DefaultThing, { Existing as Alias /* keep */, Button } from 'ui';\n`)
  })

  it('promotes a declaration-level type-only import to runtime', () => {
    const code = `import type { Button, ButtonProps } from "ui"\n'use client'\nexport default () => <Button />\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button']))

    expect(output).toContain('import { Button, type ButtonProps } from "ui"')
    expect(output).not.toContain('import type { Button')
    expect(output.indexOf('import { Button')).toBeLessThan(output.indexOf(`'use client'`))
  })

  it('promotes inline type-only specifiers and preserves aliases', () => {
    const code = `import { type Button as X, type ButtonProps, Existing } from "ui"\nconst value = X\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['X', 'Input']))

    expect(output).toContain('import { Button as X, type ButtonProps, Existing, Input } from "ui"')
    expect(output).not.toContain('type Button as X')
  })

  it('promotes requested bindings across multiple type-only declarations', () => {
    const code = `#!/usr/bin/env node
'use client'
import type { Button } from "ui"
import type { Input } from "ui"
export default () => <><Button /><Input /></>
`
    const edits = createImportEdits(code, 'ui', ['Button', 'Input'])
    const output = applyEdits(code, edits)

    expect(edits).toHaveLength(2)
    expect(edits[0].end).toBeLessThanOrEqual(edits[1].start)
    expect(output).toContain('import { Button } from "ui"')
    expect(output).toContain('import { Input } from "ui"')
    expect(output).not.toContain('import type { Button')
    expect(output).not.toContain('import type { Input')
    expect(output.startsWith('#!/usr/bin/env node\n\'use client\'')).toBe(true)
  })

  it('promotes aliases across multiple type-only declarations', () => {
    const code = `import type { Button as AppButton } from "ui"
import type { Input as AppInput } from "ui"
const view = [AppButton, AppInput]
`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['AppButton', 'AppInput']))

    expect(output).toContain('import { Button as AppButton } from "ui"')
    expect(output).toContain('import { Input as AppInput } from "ui"')
    expect(output).not.toContain('type Button as AppButton')
    expect(output).not.toContain('type Input as AppInput')
  })

  it('promotes a remaining type binding when another binding is already runtime', () => {
    const code = `import { Button } from "ui"
import type { Input } from "ui"
const view = [Button, Input]
`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button', 'Input']))

    expect(output.match(/import \{ Button \} from "ui"/g)).toHaveLength(1)
    expect(output).toContain('import { Input } from "ui"')
  })

  it('keeps type-only bindings from other sources occupied', () => {
    const code = `import type { Button } from "other-ui"\nexport default () => <Button />\n`
    expect(createImportEdits(code, 'ui', ['Button'])).toEqual([])
  })

  it('promotes a type-only default import to runtime', () => {
    const code = `import type Button from "ui"\nexport default () => <Button />\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button'], 'default'))

    expect(output).toContain('import Button from "ui"')
    expect(output).not.toContain('import type Button')
  })

  it('promotes a type-only namespace import to runtime', () => {
    const code = `import type * as UI from "ui"\nexport default () => <UI.Button />\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['UI'], 'as default'))

    expect(output).toContain('import * as UI from "ui"')
    expect(output).not.toContain('import type * as UI')
  })

  it('does not promote a type-only default import over an existing value binding', () => {
    const code = `import type Button from "ui"\nconst Button = LocalButton\n`
    expect(createImportEdits(code, 'ui', ['Button'], 'default')).toEqual([])
  })

  it('does not promote a type-only namespace import over an existing value binding', () => {
    const code = `import type * as UI from "ui"\nconst UI = createLocalUI()\n`
    expect(createImportEdits(code, 'ui', ['UI'], 'as default')).toEqual([])
  })

  it('does not promote a type-only default import over type declarations', () => {
    for (const declaration of ['interface Button { local: true }', 'type Button = string', 'enum Button { Local }']) {
      const code = `import type Button from "ui"\n${declaration}\n`
      expect(createImportEdits(code, 'ui', ['Button'], 'default')).toEqual([])
    }
  })

  it('allows a default import to merge with a namespace declaration', () => {
    const code = `import type Button from "ui"\nnamespace Button {}\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button'], 'default'))
    expect(output).toContain('import Button from "ui"')
  })

  it('does not promote type-only named imports over declarations', () => {
    for (const declaration of ['interface Button { local: true }', 'type Button = string', 'enum Button { Local }', 'namespace Button {}']) {
      const code = `import type { Button } from "ui"\n${declaration}\n`
      expect(createImportEdits(code, 'ui', ['Button'], 'specifier')).toEqual([])
    }
  })

  it('does not promote runtime imports over interface, type, or enum declarations', () => {
    for (const importWay of ['default', 'specifier'] as const) {
      for (const declaration of ['interface Button { local: true }', 'type Button = string', 'enum Button { Local }']) {
        const code = `${declaration}\n`
        expect(createImportEdits(code, 'ui', ['Button'], importWay)).toEqual([])
      }
    }
  })

  it('does not promote a type-only namespace import over a namespace declaration', () => {
    const code = `import type * as UI from "ui"\nnamespace UI {}\n`
    expect(createImportEdits(code, 'ui', ['UI'], 'as default')).toEqual([])
  })

  it('resolves unoccupied imports when another requested binding conflicts', () => {
    const code = `interface Button { local: true }\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button', 'Input'], 'specifier'))

    expect(output).toContain('import { Input } from "ui"')
    expect(output).not.toContain('import { Button, Input } from "ui"')
  })

  it('promotes a type-only default while preserving named types', () => {
    const code = `import type Button, { ButtonProps } from "ui"\nexport default () => <Button />\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button'], 'default'))

    expect(output).toContain('import Button, { type ButtonProps } from "ui"')
  })

  it('emits one valid statement per default or namespace dependency', () => {
    expect(applyEdits('', createImportEdits('', 'ui/button', ['Button', 'ButtonGroup'], 'default'))).toBe(
      'import Button from "ui/button"\nimport ButtonGroup from "ui/button"\n',
    )
    expect(applyEdits('', createImportEdits('', 'ui', ['UI', 'Icons'], 'as default'))).toBe(
      'import * as UI from "ui"\nimport * as Icons from "ui"\n',
    )
  })

  it('preserves directive prologues and shebangs', () => {
    const directives = `'use client'\n'use strict'\n\nexport default function Page() {}\n`
    const directiveOutput = applyEdits(directives, createImportEdits(directives, 'ui', ['Button']))
    expect(directiveOutput.indexOf(`'use strict'`)).toBeLessThan(directiveOutput.indexOf('import { Button }'))
    expect(directiveOutput).toContain(`'use client'\n'use strict'\nimport { Button } from "ui"\n`)

    const shebang = '#!/usr/bin/env node\nconsole.log("ok")\n'
    const shebangOutput = applyEdits(shebang, createImportEdits(shebang, 'ui', ['Button']))
    expect(shebangOutput).toBe('#!/usr/bin/env node\nimport { Button } from "ui"\nconsole.log("ok")\n')
  })

  it('keeps directives before an existing import', () => {
    const code = `'use client'\nimport { Existing } from "other"\nexport default function Page() {}\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button']))
    expect(output).toContain(`'use client'\nimport { Existing } from "other"\nimport { Button } from "ui"\n`)
  })

  it('skips names occupied by other imports or top-level declarations', () => {
    const code = `import { Button } from "other-ui"\nconst Card = {}\nfunction Dialog() {}\nclass Table {}\n`
    expect(createImportEdits(code, 'ui', ['Button', 'Card', 'Dialog', 'Table'])).toEqual([])

    const mixed = createImportEdits(code, 'ui', ['Button', 'Input'])
    expect(applyEdits(code, mixed)).toContain('import { Input } from "ui"')
    expect(applyEdits(code, mixed)).not.toContain('import { Button, Input } from "ui"')
  })

  it('declines edits for an external Vue script that cannot be registered locally', () => {
    const vue = '<template><Button /></template>\n<script src="./component.ts"></script>\n'
    expect(createImportEdits(vue, 'ui', ['Button'], 'specifier', true)).toEqual([])
  })

  it('ignores script-like text inside Vue comments', () => {
    const vue = '<!-- <script setup>fake</script> -->\n<template><Button /></template>\n'
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
    expect(output).toContain('<!-- <script setup>fake</script> -->')
    expect(output).toContain('<script>\nimport { Button } from "ui"\nexport default { components: { Button } }\n</script>')
  })

  it('parses TypeScript generic arrows with the TS script kind', () => {
    const vue = `<script setup lang="ts">
const identity = <T>(value: T) => value
const Button = {}
</script>`
    expect(createImportEdits(vue, 'ui', ['Button'], 'specifier', true)).toEqual([])
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Input'], 'specifier', true))
    expect(output).toContain('import { Input } from "ui"')
    expect(output).toContain('const identity = <T>(value: T) => value')
  })

  it('declines edits when script setup is external', () => {
    const vue = '<script setup src="./setup.ts"></script>\n<script>\nconst x = 1\n</script>\n'
    expect(createImportEdits(vue, 'ui', ['Button'], 'specifier', true)).toEqual([])
  })

  it('imports and registers components in an Options API script', () => {
    const vue = `<template><Button /></template>\n<script lang="ts">\nexport default { name: 'Page' }\n</script>\n`
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
    expect(output).toContain(`<script lang="ts">\nimport { Button } from "ui"`)
    expect(output).toContain(`components: { Button }`)
    expect(output).not.toContain('<script setup')
  })

  it.each(['defineComponent', 'defineNuxtComponent'])('registers into an existing %s components option', (factory) => {
    const vue = `<template><Button /></template>\n<script>\nexport default ${factory}({ components: { Existing } })\n</script>\n`
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
    expect(output).toContain('import { Button } from "ui"')
    expect(output).toContain('components: { Existing , Button }')
    expect(output).not.toContain('<script setup')
  })

  it.each([
    'export default { ...options }',
    'export default defineComponent({ ...options })',
    'export default defineNuxtComponent({ components: {}, ...options })',
    'export default factory({ components: {} })',
  ])('declines unsafe Vue component registration for %s', (declaration) => {
    const vue = `<script>\n${declaration}\n</script>\n`
    expect(createImportEdits(vue, 'ui', ['Button'], 'specifier', true)).toEqual([])
  })

  it('preserves trailing commas when extending an Options API components object', () => {
    const multiline = `<script>\nexport default {\n  components: {\n    Existing,\n  },\n}\n</script>`
    const singleLine = `<script>export default { components: { Existing, } }</script>`
    for (const vue of [multiline, singleLine]) {
      const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
      expect(output).not.toContain(',,')
      expect(output).not.toMatch(/,\s*,\s*Button/)
      expect(output).toContain('Button')
    }
  })

  it('does not register occupied bindings and supports static string component keys', () => {
    const occupied = `<script>\nconst Button = {}\nexport default { components: {} }\n</script>`
    expect(createImportEdits(occupied, 'ui', ['Button'], 'specifier', true)).toEqual([])

    for (const key of [`'components'`, `['components']`]) {
      const vue = `<script>export default { ${key}: { Existing } }</script>`
      const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
      expect(output.match(/components/g)?.length).toBe(1)
      expect(output).toContain('Existing')
      expect(output).toContain('Button')
    }

    const dynamic = `<script>const key = 'components'; export default { [key]: {} }</script>`
    expect(createImportEdits(dynamic, 'ui', ['Button'], 'specifier', true)).toEqual([])
  })

  it('recognizes static string and computed component registration keys', () => {
    for (const existing of [`'Button': Button`, `['Button']: Button`]) {
      const vue = `<script>export default { components: { ${existing} } }</script>`
      const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
      expect(output.match(/Button/g)?.length).toBe(3)
      expect(output).not.toMatch(/Button[^}]*,\s*Button/)
    }

    const aliased = `<script>export default { components: { AppButton: Button } }</script>`
    const output = applyEdits(aliased, createImportEdits(aliased, 'ui', ['Button'], 'specifier', true))
    expect(output).toMatch(/AppButton: Button\s*, Button/)
  })

  it('uses stable Vue block identity after offsets move', () => {
    const original = `<script lang="tsx">\nconst node = <Button />\n</script>\n<script setup lang="ts">\nconst count = ref(0)\n</script>`
    const shifted = `<!-- formatter inserted this -->\n${original}`
    const output = applyEdits(shifted, createImportEdits(shifted, 'ui', ['Button'], 'specifier', 'vue', {
      languageId: 'vue',
      preferredOffset: original.indexOf('const node'),
      preferredVueBlock: 'script',
      expectedBlockLang: 'tsx',
      registerVueComponent: false,
    }))
    const normalEnd = output.indexOf('</script>')
    expect(output.slice(0, normalEnd)).toContain('import { Button } from "ui"')
    expect(output.slice(normalEnd)).not.toContain('import { Button } from "ui"')

    const setupOnly = `<script setup lang="ts"></script>`
    expect(createImportEdits(setupOnly, 'ui', ['Button'], 'specifier', 'vue', {
      preferredVueBlock: 'script',
      expectedBlockLang: 'tsx',
    })).toEqual([])
  })

  it('targets the active Vue script block when normal script and setup coexist', () => {
    const vue = `<script lang="tsx">\nconst node = <Button />\n</script>\n<script setup lang="ts">\nconst count = ref(0)\n</script>`
    const normalOffset = vue.indexOf('const node')
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', 'vue', {
      languageId: 'vue',
      preferredOffset: normalOffset,
      registerVueComponent: false,
    }))
    const normalEnd = output.indexOf('</script>')
    expect(output.slice(0, normalEnd)).toContain('import { Button } from "ui"')
    expect(output.slice(normalEnd)).not.toContain('import { Button } from "ui"')
    expect(output).not.toContain('components: { Button }')
  })

  it('inserts into Vue script setup and creates a Vue 2-compatible script when absent', () => {
    const vue = `<template><Button /></template>\n<script setup lang="ts">\nconst x = 1\n</script>\n`
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
    expect(output).toContain('<script setup lang="ts">\nimport { Button } from "ui"\nconst x = 1')

    const withoutScript = '<template><Button /></template>\n'
    expect(applyEdits(withoutScript, createImportEdits(withoutScript, 'ui', ['Button'], 'specifier', true))).toContain(
      '<script>\nimport { Button } from "ui"\nexport default { components: { Button } }\n</script>',
    )
  })

  it('inserts Svelte imports into the instance script', () => {
    const cases = [
      ['<Button />', '<script>\nimport * as Button from "ui"\n</script>\n<Button />'],
      ['<script>let count = 0</script>\n<Button />', '<script>\nimport * as Button from "ui"\nlet count = 0</script>'],
      ['<script module>export const x = 1</script>\n<script>let count = 0</script>', '<script module>export const x = 1</script>\n<script>\nimport * as Button from "ui"\nlet count = 0</script>'],
      ['<script lang="ts">let count: number = 0</script>', '<script lang="ts">\nimport * as Button from "ui"\nlet count: number = 0</script>'],
    ] as const
    for (const [code, expected] of cases) {
      const output = applyEdits(code, createImportEdits(code, 'ui', ['Button'], 'as default', 'svelte', { languageId: 'svelte', uri: 'file:///App.svelte' }))
      expect(output).toContain(expected)
    }
  })

  it('reuses an existing Svelte instance script while the template is incomplete', () => {
    for (const [body, tail] of [['let count: number = 0', '<Button disabled'], ['', '<Button value="'], ['', '{#if']]) {
      const code = `<script module>export const x = 1</script>\n<script lang="ts">${body}</script>\n${tail}`
      const output = applyEdits(code, createImportEdits(code, 'ui', ['Button'], 'as default', 'svelte', { languageId: 'svelte' }))
      const instanceScripts = output.match(/<script\b[^>]*>/g)?.filter(tag => !tag.includes('module')) || []
      expect(instanceScripts).toHaveLength(1)
      expect(output).toContain('<script lang="ts">\nimport * as Button from "ui"')
      expect(output.indexOf('import * as Button')).toBeGreaterThan(output.indexOf('<script lang="ts">'))
      expect(output).toContain('<script module>export const x = 1</script>')
    }
  })

  it('creates an instance script beside a Svelte module script and deduplicates imports', () => {
    const moduleOnly = '<script context="module">export const x = 1</script>\n<Button />'
    const created = applyEdits(moduleOnly, createImportEdits(moduleOnly, 'ui', ['Button'], 'as default', 'svelte', { languageId: 'svelte' }))
    expect(created).toContain('<script>\nimport * as Button from "ui"\n</script>')
    expect(created).toContain('<script context="module">export const x = 1</script>')

    const existing = '<script>import * as Button from "ui"\nlet x = 1</script>\n<Button />'
    expect(createImportEdits(existing, 'ui', ['Button'], 'as default', 'svelte', { languageId: 'svelte' })).toEqual([])
  })
})
