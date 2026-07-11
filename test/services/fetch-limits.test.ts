import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ui/ui-find', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

describe('legacy adapter aggregate limits', () => {
  it('rejects adapters with more exports than allowed', async () => {
    const { validateLegacyAdapterLimits } = await import('../../src/services/fetch')
    const keys = Array.from({ length: 501 }, (_, index) => `Export${index}`)
    expect(() => validateLegacyAdapterLimits(keys, [], 'fixture')).toThrow('too many exports')
  })

  it('rejects cumulative results over the total budget', async () => {
    const { validateLegacyAdapterLimits } = await import('../../src/services/fetch')
    expect(() => validateLegacyAdapterLimits(
      ['One', 'Two'],
      [6, 6],
      'fixture',
      { maxExports: 10, maxSingleResultSize: 8, maxTotalResultSize: 10 },
    )).toThrow('too large in total')
  })

  it('keeps enforcing the per-export result budget', async () => {
    const { validateLegacyAdapterLimits } = await import('../../src/services/fetch')
    expect(() => validateLegacyAdapterLimits(
      ['One'],
      [9],
      'fixture',
      { maxExports: 10, maxSingleResultSize: 8, maxTotalResultSize: 20 },
    )).toThrow('invalid or too large')
  })
})
