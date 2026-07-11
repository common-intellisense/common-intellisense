import { describe, expect, it } from 'vitest'
import { getRefMembers, selectScopedCompletions } from '../src/index'

describe('provider safety helpers', () => {
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

  it('returns no members for unsupported Vue or React refs', () => {
    expect(getRefMembers({} as any, 'LocalWrapper')).toBeUndefined()
    expect(getRefMembers({ Native: { methods: undefined, exposed: undefined } } as any, 'Native')).toEqual([])
  })
})
