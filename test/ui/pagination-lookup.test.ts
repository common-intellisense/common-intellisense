import { describe, expect, it } from 'vitest'
// Minimal fake completion entry
const ElPagination = {
  completions: [() => []],
  events: [() => []],
  methods: [],
  exposed: [],
  slots: [],
  suggestions: [],
  tableDocument: null,
  uiName: 'el-pagination',
  lib: 'element-plus',
}

describe('pagination lookup', () => {
  it('findPrefixedComponent should match Pagination against ElPagination key', async () => {
    // Import the real util (setup.ts mocks runtime deps before module load)
    const { findPrefixedComponent } = await import('../../src/ui/utils')
    const uiCompletions: any = { ElPagination }
    const res = findPrefixedComponent('Pagination', ['el'], uiCompletions)
    expect(res).toBe(ElPagination)
  })

  it('prefers an exact prefixed key and rejects ambiguous suffix-only matches', async () => {
    const { findPrefixedComponent } = await import('../../src/ui/utils')
    const ElButton = { ...ElPagination, uiName: 'el-button' }
    const ElRadioButton = { ...ElPagination, uiName: 'el-radio-button' }
    const ElCheckboxButton = { ...ElPagination, uiName: 'el-checkbox-button' }
    const completions = { ElButton, ElRadioButton, ElCheckboxButton }

    expect(findPrefixedComponent('Button', ['el'], completions)).toBe(ElButton)
    expect(findPrefixedComponent('Button', [], { ElRadioButton, ElCheckboxButton })).toBeNull()
  })
})
