import { describe, expect, it } from 'vitest'
import { normalizePackageRecordConfiguration, normalizeSelectedUIs } from '../../src/ui/ui-utils'

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
