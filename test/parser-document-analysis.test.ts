import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDocumentAnalysis, commitDocumentSlotAnalysis, getDocumentSlotAnalysis, registerCodeLensProviderFn } from '../src/parser'

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

  it('notifies CodeLens consumers after analysis commits', () => {
    const provider = registerCodeLensProviderFn() as any
    const listener = vi.fn()
    const disposable = provider.onDidChangeCodeLenses(listener)

    commitDocumentSlotAnalysis('file:///workspace/a.vue', { version: 1, children: [] })

    expect(listener).toHaveBeenCalledTimes(1)
    disposable.dispose()
  })

  it('keeps only the 20 most recently committed documents', () => {
    for (let i = 0; i < 21; i++)
      commitDocumentSlotAnalysis(`file:///workspace/${i}.vue`, { version: 1, children: [] })

    expect(getDocumentSlotAnalysis('file:///workspace/0.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/20.vue')).toBeDefined()
  })

  it('can clear one document without affecting another', () => {
    commitDocumentSlotAnalysis('file:///workspace/a.vue', { version: 1, children: [] })
    commitDocumentSlotAnalysis('file:///workspace/b.vue', { version: 1, children: [] })

    clearDocumentAnalysis('file:///workspace/a.vue')

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')).toBeDefined()
  })
})
