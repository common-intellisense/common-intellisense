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
