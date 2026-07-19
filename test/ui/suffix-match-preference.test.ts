import { expect, it } from 'vitest'
import { findPrefixedComponent } from '../../src/ui/utils'

it('rejects ambiguous suffix matches across libraries', () => {
  const UiCompletions: any = {
    ElPagination: { uiName: 'ElPagination', lib: 'element' },
    APagination: { uiName: 'APagination', lib: 'another' },
  }

  expect(findPrefixedComponent('Pagination', [], UiCompletions)).toBeNull()
})

it('does not guess between nested suffix matches', () => {
  const UiCompletions: any = {
    ElPagination: { uiName: 'ElPagination', lib: 'element' },
    SuperElPagination: { uiName: 'SuperElPagination', lib: 'super' },
  }

  expect(findPrefixedComponent('Pagination', [], UiCompletions)).toBeNull()
})
