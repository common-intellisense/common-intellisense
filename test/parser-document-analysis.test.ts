import { beforeEach, describe, expect, it, vi } from 'vitest'
import { beginDocumentSlotAnalysis, clearDocumentAnalysesForPackages, clearDocumentAnalysis, commitDocumentSlotAnalysis, findUiTag, getDocumentSlotAnalysis, registerCodeLensProviderFn } from '../src/parser'

const identity = { packagePath: '/workspace/package.json', contextGeneration: 1, contextRevision: 1 }

function commit(uri: string, documentVersion: number, children: any[], slotIdentity = identity) {
  const request = beginDocumentSlotAnalysis(uri, documentVersion, slotIdentity)
  return commitDocumentSlotAnalysis(request, children)
}

describe('per-document slot analysis', () => {
  beforeEach(() => clearDocumentAnalysis())

  it('keeps analyses isolated by document URI', () => {
    commit('file:///workspace/a.vue', 1, [{ id: 'a' }])
    commit('file:///workspace/b.vue', 1, [{ id: 'b' }])

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')?.children).toEqual([{ id: 'a' }])
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')?.children).toEqual([{ id: 'b' }])
  })

  it('rejects an older request with the same document version and different context', () => {
    const uri = 'file:///workspace/a.vue'
    const oldRequest = beginDocumentSlotAnalysis(uri, 7, identity)
    const newRequest = beginDocumentSlotAnalysis(uri, 7, { ...identity, contextGeneration: 2 })

    expect(commitDocumentSlotAnalysis(newRequest, [{ id: 'new' }])).toBe(true)
    expect(commitDocumentSlotAnalysis(oldRequest, [{ id: 'old' }])).toBe(false)
    expect(getDocumentSlotAnalysis(uri)).toMatchObject({
      documentVersion: 7,
      contextGeneration: 2,
      children: [{ id: 'new' }],
    })
  })

  it('tracks context revision when enhanced sources replace the baseline', () => {
    const uri = 'file:///workspace/a.vue'
    commit(uri, 7, [{ id: 'baseline' }], identity)
    commit(uri, 7, [{ id: 'enhanced' }], { ...identity, contextRevision: 2 })

    expect(getDocumentSlotAnalysis(uri)).toMatchObject({
      documentVersion: 7,
      contextGeneration: 1,
      contextRevision: 2,
      children: [{ id: 'enhanced' }],
    })
  })

  it('does not let a lower revision started later replace a committed higher revision', () => {
    const uri = 'file:///workspace/a.vue'
    commit(uri, 7, [{ id: 'new' }], { ...identity, contextRevision: 2 })
    const stale = beginDocumentSlotAnalysis(uri, 7, identity)

    expect(commitDocumentSlotAnalysis(stale, [{ id: 'old' }])).toBe(false)
    expect(getDocumentSlotAnalysis(uri)?.children).toEqual([{ id: 'new' }])
  })

  it('does not let a lower revision supersede an in-flight higher revision', () => {
    const uri = 'file:///workspace/a.vue'
    const newer = beginDocumentSlotAnalysis(uri, 7, { ...identity, contextRevision: 2 })
    const stale = beginDocumentSlotAnalysis(uri, 7, identity)

    expect(commitDocumentSlotAnalysis(stale, [{ id: 'old' }])).toBe(false)
    expect(commitDocumentSlotAnalysis(newer, [{ id: 'new' }])).toBe(true)
  })

  it('does not let a cleared in-flight request revive stale analysis', () => {
    const uri = 'file:///workspace/a.vue'
    const stale = beginDocumentSlotAnalysis(uri, 7, identity)
    clearDocumentAnalysis()

    expect(commitDocumentSlotAnalysis(stale, [{ id: 'stale' }])).toBe(false)
    expect(getDocumentSlotAnalysis(uri)).toBeUndefined()
  })

  it('does not return CodeLens from an older document version', () => {
    const uri = 'file:///workspace/a.vue'
    commit(uri, 1, [{ id: 'old' }])
    const provider = registerCodeLensProviderFn() as any
    const document = {
      languageId: 'vue',
      version: 2,
      uri: { toString: () => uri },
      getText: () => '<template />',
    }

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('notifies CodeLens consumers after analysis commits', () => {
    const provider = registerCodeLensProviderFn() as any
    const listener = vi.fn()
    const disposable = provider.onDidChangeCodeLenses(listener)

    commit('file:///workspace/a.vue', 1, [])

    expect(listener).toHaveBeenCalledTimes(1)
    disposable.dispose()
  })

  it('keeps only the 20 most recently committed documents', () => {
    for (let i = 0; i < 21; i++)
      commit(`file:///workspace/${i}.vue`, 1, [])

    expect(getDocumentSlotAnalysis('file:///workspace/0.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/20.vue')).toBeDefined()
  })

  it('clears analyses only for affected packages', () => {
    const a = { ...identity, packagePath: '/workspace/a/package.json' }
    const b = { ...identity, packagePath: '/workspace/b/package.json' }
    commit('file:///workspace/a.vue', 1, [], a)
    commit('file:///workspace/b.vue', 1, [], b)

    clearDocumentAnalysesForPackages(['/workspace/a/package.json'])

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')).toBeDefined()
  })

  it('finds slots for JSX compound components', async () => {
    const child = {
      type: 'JSXElement',
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
      children: [],
      openingElement: {
        name: {
          type: 'JSXMemberExpression',
          object: { type: 'JSXIdentifier', name: 'Form' },
          property: { type: 'JSXIdentifier', name: 'Item' },
        },
      },
    }
    const rawSlots = [{ name: 'label' }]

    await expect(findUiTag([child], { 'Form.Item': { rawSlots } })).resolves.toEqual([{ child, slots: rawSlots }])
  })

  it('can clear one document without affecting another', () => {
    commit('file:///workspace/a.vue', 1, [])
    commit('file:///workspace/b.vue', 1, [])

    clearDocumentAnalysis('file:///workspace/a.vue')

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')).toBeDefined()
  })
})
