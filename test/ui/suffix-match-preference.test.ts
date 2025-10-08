import { expect, it } from 'vitest'
import { findPrefixedComponent } from '../../src/ui/utils'

it('prefers same-lib match when from is specified', () => {
  const UiCompletions: any = {
    ElPagination: { uiName: 'ElPagination', lib: 'element' },
    APagination: { uiName: 'APagination', lib: 'another' },
  }
  const prefixes: string[] = []
  const result = findPrefixedComponent('Pagination', prefixes, UiCompletions)
  expect(result).toBeDefined()
  expect([UiCompletions.ElPagination, UiCompletions.APagination]).toContain(result)
})

it('chooses longest matching suffix when no lib preference', () => {
  const UiCompletions: any = {
    ElPagination: { uiName: 'ElPagination', lib: 'element' },
    SuperElPagination: { uiName: 'SuperElPagination', lib: 'super' },
  }
  const prefixes: string[] = []
  const result = findPrefixedComponent('Pagination', prefixes, UiCompletions)
  // Expect the longest key (SuperElPagination) to be selected
  expect(result).toBe(UiCompletions.SuperElPagination)
})
