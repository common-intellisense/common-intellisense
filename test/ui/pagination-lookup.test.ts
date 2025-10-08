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
})
