import { beforeEach, describe, expect, it } from 'vitest'
import { clearDocumentAnalysis, commitDocumentSlotAnalysis, getDocumentSlotAnalysis } from '../src/parser'

describe('per-document slot analysis', () => {
  beforeEach(() => clearDocumentAnalysis())

  it('keeps analyses isolated by document URI', () => {
    commitDocumentSlotAnalysis('file:///workspace/a.vue', { version: 1, children: [{ id: 'a' }] })
    commitDocumentSlotAnalysis('file:///workspace/b.vue', { version: 1, children: [{ id: 'b' }] })

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')?.children).toEqual([{ id: 'a' }])
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')?.children).toEqual([{ id: 'b' }])
  })

  it('does not allow an older analysis to overwrite a newer version', () => {
    expect(commitDocumentSlotAnalysis('file:///workspace/a.vue', { version: 3, children: [{ id: 'new' }] })).toBe(true)
    expect(commitDocumentSlotAnalysis('file:///workspace/a.vue', { version: 2, children: [{ id: 'old' }] })).toBe(false)

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')).toEqual({
      version: 3,
      children: [{ id: 'new' }],
    })
  })

  it('can clear one document without affecting another', () => {
    commitDocumentSlotAnalysis('file:///workspace/a.vue', { version: 1, children: [] })
    commitDocumentSlotAnalysis('file:///workspace/b.vue', { version: 1, children: [] })

    clearDocumentAnalysis('file:///workspace/a.vue')

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')).toBeDefined()
  })
})
