import { describe, expect, it } from 'vitest'
import { getUiDeps, normalizePackageRecordConfiguration, normalizeSelectedUIs } from '../../src/ui/ui-utils'

describe('package-scoped UI configuration', () => {
  it('returns direct legacy configuration shapes', () => {
    expect(normalizeSelectedUIs(['antd5'], '/workspace/package.json')).toEqual(['antd5'])
    expect(normalizePackageRecordConfiguration({ '@acme/ui': 'antd5' }, '/workspace/package.json')).toEqual({ '@acme/ui': 'antd5' })
    expect(normalizePackageRecordConfiguration({ antd: 'x-' }, '/workspace/package.json')).toEqual({ antd: 'x-' })
  })

  it('returns package values, including an explicitly empty selection', () => {
    expect(normalizeSelectedUIs({ '/workspace/a/package.json': [] }, '/workspace/a/package.json')).toEqual([])
    expect(normalizePackageRecordConfiguration({
      '/workspace/a/package.json': { '@acme/ui': 'antd5' },
    }, '/workspace/a/package.json')).toEqual({ '@acme/ui': 'antd5' })
    expect(normalizePackageRecordConfiguration({
      '/workspace/a/package.json': { antd: 'a-' },
    }, '/workspace/a/package.json')).toEqual({ antd: 'a-' })
  })

  it('resolves documented workspace-relative package keys', () => {
    const packagePath = '/workspace/packages/a/package.json'
    expect(normalizeSelectedUIs({
      '${workspaceFolder}/packages/a/package.json': ['antd5'],
    }, packagePath, '/workspace')).toEqual(['antd5'])
    expect(normalizeSelectedUIs({
      './packages/a/package.json': ['elementPlus2'],
    }, packagePath, '/workspace')).toEqual(['elementPlus2'])
    expect(normalizePackageRecordConfiguration({
      '${workspaceFolder}/packages/a/package.json': { antd: 'a-' },
    }, packagePath, '/workspace')).toEqual({ antd: 'a-' })
    expect(normalizeSelectedUIs({
      './packages/a/package.json': ['antd5'],
    }, '/other/packages/a/package.json', '/workspace')).toEqual(['auto'])
  })

  it('does not infer an SFC from a JSX script element', () => {
    const deps = getUiDeps(`
      import { Button } from 'antd'
      export const App = () => <script>console.log('bootstrap')</script>
    `, { languageId: 'typescriptreact', uri: 'file:///App.tsx' })
    expect(deps).toEqual({ Button: 'antd' })
  })

  it('uses the Vue descriptor and ignores fake script text', () => {
    const deps = getUiDeps(`
      <!-- <script>import { Fake } from 'fake'</script> -->
      <template><Button /></template>
      <script>import DefaultThing from 'first'</script>
      <script setup>import { Button as AppButton } from 'antd'</script>
    `, { languageId: 'vue', uri: 'file:///App.vue' })
    expect(deps).toEqual({ DefaultThing: 'first', AppButton: 'antd' })
  })

  it('uses only the Svelte instance script for template dependencies', () => {
    const moduleOnly = getUiDeps(`<script module>import ModuleButton from '@a/ui'</script><ModuleButton />`, { languageId: 'svelte', uri: 'file:///App.svelte' })
    expect(moduleOnly).toEqual({})

    const both = getUiDeps(`
      <script context="module">import Button from '@module/ui'</script>
      <script>import Button from '@instance/ui'</script>
      <Button />
    `, { languageId: 'svelte', uri: 'file:///App.svelte' })
    expect(both).toEqual({ Button: '@instance/ui' })
  })

  it('uses typed defaults when the package mapping has no current entry', () => {
    expect(normalizeSelectedUIs({ '/workspace/a/package.json': ['antd5'] }, '/workspace/b/package.json')).toEqual(['auto'])
    expect(normalizePackageRecordConfiguration({
      '/workspace/a/package.json': { '@acme/ui': 'antd5' },
    }, '/workspace/b/package.json')).toEqual({})
    expect(normalizePackageRecordConfiguration({
      '/workspace/a/package.json': { antd: 'a-' },
    }, '/workspace/b/package.json')).toEqual({})
  })
})
