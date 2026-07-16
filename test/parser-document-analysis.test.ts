import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beginDocumentSlotAnalysis, clearDocumentAnalysesForPackages, clearDocumentAnalysis, commitDocumentSlotAnalysis, findUiTag, getDocumentSlotAnalysis, getImportDeps, registerCodeLensProviderFn, resolveLocalComponentModule } from '../src/parser'
import { getUiDeps } from '../src/ui/ui-utils'

const identity = { packagePath: '/workspace/package.json', contextGeneration: 1, contextRevision: 1 }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })))
})

function commit(uri: string, documentVersion: number, children: any[], slotIdentity = identity) {
  const request = beginDocumentSlotAnalysis(uri, documentVersion, slotIdentity)
  return commitDocumentSlotAnalysis(request, children)
}

describe('native tag isolation', () => {
  it('does not suffix-match native HTML or SVG tags to UI components', async () => {
    const completions: any = {
      ElSelect: { marker: 'select', lib: '@ui/select' },
      ElOption: { marker: 'option' },
      ElDialog: { marker: 'dialog' },
      UiPath: { marker: 'path' },
    }
    const tags = ['select', 'option', 'textarea', 'nav', 'dialog', 'details', 'summary', 'svg', 'path']
    const children = tags.map((tag, index) => ({ tag, loc: index + 1, children: [] }))
    expect(await findUiTag(children, completions)).toEqual([])
  })
})

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

  it('does not expose Vue slot CodeLens in React documents', () => {
    const uri = 'file:///workspace/a.tsx'
    commit(uri, 1, [{
      offset: 0,
      children: [{
        child: { tag: 'Modal', children: [], loc: { start: { line: 1, column: 0, offset: 0 }, end: { line: 1, column: 9, offset: 9 } } },
        slots: [{ name: 'footer' }],
      }],
    }])
    const provider = registerCodeLensProviderFn() as any
    const document = {
      languageId: 'typescriptreact',
      version: 1,
      uri: { toString: () => uri },
      getText: () => '<Modal />',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    }

    expect(provider.provideCodeLenses(document)).toEqual([])
  })

  it('passes only serializable edit coordinates to the slot command', () => {
    const uri = 'file:///workspace/a.vue'
    const child: any = {
      tag: 'Modal',
      children: [],
      isSelfClosing: true,
      loc: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 10, offset: 9 } },
    }
    child.parent = child
    commit(uri, 1, [{ offset: 0, children: [{ child, slots: [{ name: 'footer' }] }] }])
    const document = {
      languageId: 'vue',
      version: 1,
      uri: { toString: () => uri },
      getText: () => '<Modal />',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    }

    const [lens] = (registerCodeLensProviderFn() as any).provideCodeLenses(document)
    expect(lens.command.arguments[0]).toEqual({ start: 0, end: 9, lastChildEnd: undefined, tag: 'Modal', selfClosing: true, column: 1, sameLine: true })
    expect(() => JSON.stringify(lens.command.arguments)).not.toThrow()
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

  it('does not cancel an in-flight replacement when its old committed entry is evicted', () => {
    const uri = 'file:///workspace/a.vue'
    commit(uri, 1, [{ id: 'old' }])
    const replacement = beginDocumentSlotAnalysis(uri, 2, identity)
    for (let i = 0; i < 20; i++)
      commit(`file:///workspace/other-${i}.vue`, 1, [])

    expect(getDocumentSlotAnalysis(uri)).toBeUndefined()
    expect(commitDocumentSlotAnalysis(replacement, [{ id: 'new' }])).toBe(true)
    expect(getDocumentSlotAnalysis(uri)?.children).toEqual([{ id: 'new' }])
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

  it('uses import aliases and source scopes before flattened Slot candidates', async () => {
    const makeChild = () => ({
      type: 'JSXElement',
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
      children: [],
      openingElement: { name: { type: 'JSXIdentifier', name: 'AppModal' } },
    })
    const antdSlots = [{ name: 'antd-slot' }]
    const muiSlots = [{ name: 'mui-slot' }]
    const deps = getUiDeps(`import { Modal as AppModal } from '@private/ui/modal'`) || {}
    const sourceContext = {
      cacheMap: new Map([['antd5', { Modal: { lib: 'antd', rawSlots: antdSlots } }]]),
      sourceScopes: new Map([['@private/ui', { key: 'antd5', lib: 'antd' }]]),
    }

    const child = makeChild()
    await expect(findUiTag([child], { AppModal: { lib: 'mui', rawSlots: muiSlots } }, [], new Set(), deps, [], sourceContext)).resolves.toEqual([{ child, slots: antdSlots }])
    await expect(findUiTag([makeChild()], { AppModal: { lib: 'mui', rawSlots: muiSlots } }, [], new Set(), { AppModal: '@unknown/ui' }, [], sourceContext)).resolves.toEqual([])
  })

  it('resolves Slot CodeLens wrappers through arbitrary tsconfig paths aliases', async () => {
    const temporaryWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'common-intellisense-slots-'))
    roots.push(temporaryWorkspace)
    const workspace = await fsp.realpath(temporaryWorkspace)
    const componentsDir = path.join(workspace, 'src', 'components')
    const documentPath = path.join(workspace, 'src', 'App.vue')
    await fsp.mkdir(componentsDir, { recursive: true })
    await Promise.all([
      fsp.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#components/*': ['src/components/*'], 'components/*': ['src/components/*'], '*': ['src/*'] } } })),
      fsp.writeFile(path.join(componentsDir, 'Wrapped.vue'), '<template><ElButton /></template>'),
    ])

    await expect(resolveLocalComponentModule('#components/Wrapped.vue', documentPath, workspace)).resolves.toBe(await fsp.realpath(path.join(componentsDir, 'Wrapped.vue')))

    const localDeps = getImportDeps(`<script setup>
import Wrapped from '#components/Wrapped.vue'
import BareWrapped from 'components/Wrapped.vue'
</script>`)
    expect(localDeps).toEqual({ Wrapped: '#components/Wrapped.vue', BareWrapped: 'components/Wrapped.vue' })

    const child = { tag: 'Wrapped', range: [0, 10], children: [] }
    const rawSlots = [{ name: 'loading' }]
    const sourceContext: any = {
      cacheMap: new Map(),
      sourceScopes: new Map(),
      localDeps,
      currentDocumentPath: documentPath,
      workspaceRoot: workspace,
    }

    await expect(findUiTag([child], { ElButton: { lib: 'element-ui', rawSlots } }, [], new Set(), {}, ['el'], sourceContext)).resolves.toEqual([{ child, slots: rawSlots }])

    const missing = { tag: 'Button', range: [11, 20], children: [] }
    sourceContext.localDeps = { Wrapped: '#components/Wrapped.vue', Button: '#components/Missing.vue' }
    await expect(findUiTag([missing], { Button: { lib: '#components/Missing.vue', rawSlots } }, [], new Set(), {}, ['el'], sourceContext)).resolves.toEqual([])

    const external = { tag: 'Button', range: [21, 30], children: [] }
    sourceContext.localDeps = { Button: 'antd' }
    sourceContext.sourceScopes = new Map([['antd', { key: 'antd5', lib: 'antd' }]])
    sourceContext.cacheMap = new Map([['antd5', { Button: { lib: 'antd', rawSlots } }]])
    await expect(findUiTag([external], {}, [], new Set(), {}, [], sourceContext)).resolves.toEqual([{ child: external, slots: rawSlots }])
  })

  it('can clear one document without affecting another', () => {
    commit('file:///workspace/a.vue', 1, [])
    commit('file:///workspace/b.vue', 1, [])

    clearDocumentAnalysis('file:///workspace/a.vue')

    expect(getDocumentSlotAnalysis('file:///workspace/a.vue')).toBeUndefined()
    expect(getDocumentSlotAnalysis('file:///workspace/b.vue')).toBeDefined()
  })
})
