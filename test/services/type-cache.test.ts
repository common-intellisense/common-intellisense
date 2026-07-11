import { describe, expect, it } from 'vitest'
import { TypeCache } from '../../src/type-extract/cache'

describe('type cache in-flight identity', () => {
  it('bounds package source snapshots with LRU eviction', () => {
    const cache = new TypeCache(2)
    cache.setSnapshot('a', ['/a.d.ts'])
    cache.setSnapshot('b', ['/b.d.ts'])
    expect(cache.getSnapshot('a')).toBeDefined()
    cache.setSnapshot('c', ['/c.d.ts'])

    expect(cache.getSnapshotSize()).toBe(2)
    expect(cache.hasSnapshot('a')).toBe(true)
    expect(cache.hasSnapshot('b')).toBe(false)
    expect(cache.hasSnapshot('c')).toBe(true)
  })

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
