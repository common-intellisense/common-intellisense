import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveLocalAdapterPath } from '../../src/services/fetch'

describe('local adapter workspace boundary', () => {
  it('resolves a workspace-root manifest from a nested package context', () => {
    const root = path.resolve('/repo')
    expect(resolveLocalAdapterPath(root, './common-intellisense.json')).toBe(path.join(root, 'common-intellisense.json'))
  })

  it('rejects paths outside the workspace root', () => {
    expect(resolveLocalAdapterPath(path.resolve('/repo'), '../outside.json')).toBeUndefined()
  })
})
