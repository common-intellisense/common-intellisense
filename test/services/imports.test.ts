import { describe, expect, it } from 'vitest'
import { createImportEdits, getSuggestedImportNames, resolveImportSource } from '../../src/services/imports'

function applyEdits(code: string, edits: ReturnType<typeof createImportEdits>) {
  return [...edits].sort((a, b) => b.start - a.start).reduce(
    (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
    code,
  )
}

describe('import transforms', () => {
  it('prefers an explicit component source over a dynamic source', () => {
    expect(resolveImportSource('@custom/button', '@fallback/${name}', 'ui', 'Button', name => name.toLowerCase())).toBe('@custom/button')
    expect(resolveImportSource(undefined, '@fallback/${name}', 'ui', 'Button', name => name.toLowerCase())).toBe('@fallback/button')
    expect(resolveImportSource(undefined, undefined, 'ui', 'Button', name => name)).toBe('ui')
  })

  it('accepts object suggestions without throwing', () => {
    expect(getSuggestedImportNames([{ name: 'Menu.Item' }], '')).toEqual(['Menu'])
    expect(getSuggestedImportNames([{ description: 'missing name' }], '')).toEqual([])
  })

  it('adds named imports without modifying type-only imports', () => {
    const code = `import type { ButtonProps } from "ui"\nimport DefaultThing, { Existing as Alias } from "ui"\nconst value = 1\n`
    const output = applyEdits(code, createImportEdits(code, 'ui', ['Button', 'Alias'], 'specifier'))
    expect(output).toContain('import type { ButtonProps } from "ui"')
    expect(output).toContain('import DefaultThing, { Existing as Alias, Button } from "ui"')
  })

  it('emits one valid statement per default or namespace dependency', () => {
    expect(applyEdits('', createImportEdits('', 'ui/button', ['Button', 'ButtonGroup'], 'default'))).toBe(
      'import Button from "ui/button"\nimport ButtonGroup from "ui/button"\n',
    )
    expect(applyEdits('', createImportEdits('', 'ui', ['UI', 'Icons'], 'as default'))).toBe(
      'import * as UI from "ui"\nimport * as Icons from "ui"\n',
    )
  })

  it('inserts into Vue script setup and creates one when absent', () => {
    const vue = `<template><Button /></template>\n<script setup lang="ts">\nconst x = 1\n</script>\n`
    const output = applyEdits(vue, createImportEdits(vue, 'ui', ['Button'], 'specifier', true))
    expect(output).toContain('<script setup lang="ts">\nimport { Button } from "ui"\nconst x = 1')

    const withoutScript = '<template><Button /></template>\n'
    expect(applyEdits(withoutScript, createImportEdits(withoutScript, 'ui', ['Button'], 'specifier', true))).toContain(
      '<script setup>\nimport { Button } from "ui"\n</script>',
    )
  })
})
