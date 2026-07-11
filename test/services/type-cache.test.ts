import { describe, expect, it } from 'vitest'
import { TypeCache } from '../../src/type-extract/cache'

describe('type cache in-flight identity', () => {
  it('does not let an old task clear a replacement task', () => {
    const cache = new TypeCache()
    const oldTask = Promise.resolve(undefined)
    const newTask = Promise.resolve(undefined)
    cache.setInFlight('key', oldTask)
    cache.clear()
    cache.setInFlight('key', newTask)

    cache.clearInFlight('key', oldTask)
    expect(cache.getInFlight('key')).toBe(newTask)

    cache.clearInFlight('key', newTask)
    expect(cache.getInFlight('key')).toBeUndefined()
  })
})
