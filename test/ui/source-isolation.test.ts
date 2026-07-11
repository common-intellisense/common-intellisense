import { describe, expect, it } from 'vitest'
import { normalizeScopedSource, resolveImportedComponent, resolveRefMembers, selectScopedCompletions } from '../../src/index'
import { findDynamicComponent } from '../../src/parser'
import { getUiDeps, getUiImportedName } from '../../src/ui/ui-utils'

describe('source-aware component resolution', () => {
  it('never falls back to a same-name component from another source', async () => {
    const muiButton = { lib: 'mui', marker: 'mui' }
    const antdButton = { lib: 'antd', marker: 'antd' }
    const reversed = {
      MuiButton: muiButton,
      AntButton: antdButton,
      Button: muiButton,
    } as any

    expect(await findDynamicComponent('Button', {}, reversed, ['mui', 'ant'], 'antd')).toBe(antdButton)
    expect(await findDynamicComponent('Button', {}, { Button: muiButton } as any, [], 'antd')).toBeFalsy()
  })

  it('normalizes wrapper aliases and package subpaths through scoped resolution', async () => {
    const antd = { Button: { lib: 'antd', marker: 'antd' } } as any
    const flattened = { Button: { lib: 'mui', marker: 'mui' } } as any
    const cache = new Map<string, any>([['antd5', antd], ['antd5Components', []], ['mui5', flattened]])
    const alias = { '@private/ui': 'antd5' }

    expect(normalizeScopedSource('@private/ui/button', alias)).toBe('antd')
    expect(normalizeScopedSource('antd/es/button', alias)).toBe('antd')
    const wrapperScoped = selectScopedCompletions(flattened, cache, '@private/ui/button', alias)
    const subpathScoped = selectScopedCompletions(flattened, cache, 'antd/es/button', alias)
    expect(await findDynamicComponent('Button', {}, wrapperScoped, [], normalizeScopedSource('@private/ui/button', alias))).toBe(antd.Button)
    expect(await findDynamicComponent('Button', {}, subpathScoped, [], normalizeScopedSource('antd/es/button', alias))).toBe(antd.Button)

    const modal = { lib: 'antd', slots: ['antd-slot'] }
    const modalCache = new Map<string, any>([['antd5', { Modal: modal }], ['antd5Components', []], ['mui5', { Modal: { lib: 'mui', slots: ['mui-slot'] } }]])
    const modalDeps = getUiDeps(`import { Modal as AppModal } from '@private/ui/modal'`)
    const modalSource = modalDeps?.AppModal
    const modalName = getUiImportedName(modalDeps, 'AppModal')
    const modalScoped = selectScopedCompletions({ Modal: { lib: 'mui' } } as any, modalCache, modalSource, alias)
    expect(await findDynamicComponent(modalName, {}, modalScoped, [], normalizeScopedSource(modalSource, alias))).toBe(modal)

    const antdButton = { lib: 'antd', methods: [{ label: 'antdMethod' }], exposed: [] }
    const refCache = new Map<string, any>([['antd5', { Button: antdButton }], ['antd5Components', []], ['mui5', { Button: { lib: 'mui', methods: [{ label: 'muiMethod' }] } }]])
    const refDeps = getUiDeps(`import { Button as AppButton } from '@private/ui/button'`) || {}
    expect(await resolveRefMembers('AppButton', refDeps, { Button: { lib: 'mui' } } as any, refCache, alias, [])).toEqual([{ label: 'antdMethod' }])
    expect(await resolveRefMembers('Button', { Button: '@unknown/private' }, { Button: { lib: 'mui', methods: [{ label: 'muiMethod' }] } } as any, refCache, alias, [])).toBeUndefined()
  })

  it('preserves compound roots for named and namespace imports', async () => {
    const antdItem = { lib: 'antd', marker: 'antd-item', methods: [{ label: 'focus' }] }
    const radixRoot = { lib: '@radix-ui/react-dialog', marker: 'radix-root' }
    const flattened = { 'Form.Item': { lib: 'other', marker: 'wrong' }, 'Dialog.Root': { lib: 'other', marker: 'wrong' } } as any
    const cache = new Map<string, any>([
      ['antd5', { 'Form.Item': antdItem }],
      ['radixDialog1', { 'Dialog.Root': radixRoot }],
    ])
    const scopes = new Map([
      ['antd', { key: 'antd5', lib: 'antd' }],
      ['@radix-ui/react-dialog', { key: 'radixDialog1', lib: '@radix-ui/react-dialog' }],
    ])
    const deps = getUiDeps(`import { Form as AntForm } from 'antd'\nimport * as Dialog from '@radix-ui/react-dialog'`) || {}

    await expect(resolveImportedComponent('AntForm.Item', deps, flattened, cache, {}, [], scopes)).resolves.toMatchObject({ component: antdItem, source: 'antd' })
    await expect(resolveImportedComponent('Dialog.Root', deps, flattened, cache, {}, [], scopes)).resolves.toMatchObject({ component: radixRoot, source: '@radix-ui/react-dialog' })
    await expect(resolveRefMembers('AntForm.Item', deps, flattened, cache, {}, [], scopes)).resolves.toEqual([{ label: 'focus' }])
  })

  it('records local names for aliased and default imports', () => {
    const deps = getUiDeps(`<script setup lang="ts">
import DefaultButton from 'private-ui'
import { Button as AppButton, type ButtonProps } from 'antd'
</script>`)

    expect(deps).toEqual({ DefaultButton: 'private-ui', AppButton: 'antd' })
    expect(getUiImportedName(deps, 'DefaultButton')).toBe('DefaultButton')
    expect(getUiImportedName(deps, 'AppButton')).toBe('Button')
  })
})
