import { describe, expect, it } from 'vitest'
import { getDependencyScopeOffset, getHoverPropName, getRefMembers, getRefVariableNames, hasComponentTag, hasRenderedComponentTag, selectScopedCompletions, supportsSlotAnalysis, unwrapLiteral } from '../src/index'

describe('provider safety helpers', () => {
  it('limits slot analysis to Vue and Vine documents', () => {
    const document = (languageId: string, fsPath: string) => ({ languageId, uri: { fsPath } }) as any
    expect(supportsSlotAnalysis(document('vue', '/App.vue'))).toBe(true)
    expect(supportsSlotAnalysis(document('typescript', '/App.vine.ts'))).toBe(true)
    expect(supportsSlotAnalysis(document('typescriptreact', '/App.tsx'))).toBe(false)
    expect(supportsSlotAnalysis(document('svelte', '/App.svelte'))).toBe(false)
  })

  it('unwraps only paired literal quotes for attribute value completions', () => {
    expect([`'top'`, ' "bottom" ', '', '`small`', '`large`'].map(unwrapLiteral).filter(Boolean)).toEqual(['top', 'bottom', 'small', 'large'])
    expect(unwrapLiteral('top')).toBe('top')
    expect(unwrapLiteral(`'don\'t'`)).toBe(`don't`)
    expect(unwrapLiteral(`'mixed"quote'`)).toBe('mixed"quote')
  })

  it('safely resolves hover names for Vue directives', () => {
    expect(getHoverPropName({ propName: true })).toBeUndefined()
    expect(getHoverPropName({ propName: undefined })).toBeUndefined()
    expect(getHoverPropName({ propName: 'disabled' })).toBe('disabled')
  })

  it('merges Vue script dependencies for template results and scopes script results', () => {
    const loc = { start: { offset: 42 } }
    expect(getDependencyScopeOffset('vue', { type: 'tag', isInTemplate: true, loc })).toBeUndefined()
    expect(getDependencyScopeOffset('vue', { type: 'props', isInTemplate: true, loc })).toBeUndefined()
    expect(getDependencyScopeOffset('vue', { type: 'script', loc })).toBe(42)
    expect(getDependencyScopeOffset('vue', { type: 'tag', syntax: 'jsx', loc })).toBe(42)
  })

  it('keeps current completions when a multi-UI source has no cache match', () => {
    const current = { Button: { methods: [], exposed: [] } } as any
    const cache = new Map<string, any>([
      ['antd5', {}],
      ['elementPlus2', {}],
      ['customComponents', []],
    ])
    expect(selectScopedCompletions(current, cache, '@private/ui/button', {})).toBe(current)
  })

  it('selects only object-shaped matching completion caches', () => {
    const current = {} as any
    const scoped = { ElButton: { methods: [], exposed: [] } }
    const cache = new Map<string, any>([['elementPlus2', scoped], ['x', {}], ['y', {}]])
    expect(selectScopedCompletions(current, cache, 'element-plus', {})).toBe(scoped)
  })

  it('normalizes Vue tuple refs and falls back to Vine ref-map variables', () => {
    expect(getRefVariableNames({ refs: [['button', 'buttonRef'], 'plain'], refsMap: {} })).toEqual(['button', 'plain'])
    expect(getRefVariableNames({ refsMap: { buttonRef: 'ElButton' } })).toEqual(['buttonRef'])
    expect(getRefVariableNames({})).toEqual([])
  })

  it('does not confuse a native lowercase tag with a PascalCase component', () => {
    expect(hasComponentTag('<button />', 'Button')).toBe(false)
    expect(hasComponentTag('<Button />', 'Button')).toBe(true)
    expect(hasComponentTag('<el-button />', 'Button', 'el')).toBe(true)
    expect(hasComponentTag('<el-button />', 'Button', 'El')).toBe(false)
    expect(hasRenderedComponentTag('<el-button />', 'el-button')).toBe(true)
    expect(hasRenderedComponentTag(`const example = '<el-button />'`, 'el-button')).toBe(false)
    expect(hasRenderedComponentTag('<!-- <el-button /> -->', 'el-button')).toBe(false)
    expect(hasRenderedComponentTag(`<template><p>Don't submit twice</p><el-button /></template>`, 'el-button', 'vue')).toBe(true)
    expect(hasRenderedComponentTag(`<template><p>One " quote</p><el-button /></template>`, 'el-button', 'vue')).toBe(true)
    expect(hasRenderedComponentTag(`<script>const example = '<el-button />'</script>`, 'el-button', 'vue')).toBe(false)
  })

  it('returns no members for unsupported Vue or React refs', () => {
    expect(getRefMembers({} as any, 'LocalWrapper')).toBeUndefined()
    expect(getRefMembers({ Native: { methods: undefined, exposed: undefined } } as any, 'Native')).toEqual([])
  })
})
