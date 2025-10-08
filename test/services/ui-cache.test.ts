import { describe, expect, it } from 'vitest'
import { cacheMap, clearUICache, getCacheMap, pkgUIConfigMap, rootPkgCache, urlCache } from '../../src/services/ui-cache'

describe('ui-cache service', () => {
  it('exports cache maps and clearUICache clears them', () => {
    // ensure maps are present
    cacheMap.set('x', { dummy: true } as any)
    pkgUIConfigMap.set('p', { propsConfig: {}, componentsConfig: {} } as any)
    urlCache.set('u', { uis: [], pkg: 'p' } as any)
    rootPkgCache.set('r', { rootPkgPath: '/tmp', rootPkg: {}, isMonorepo: false })

    const gm = getCacheMap()
    expect(gm).toBe(cacheMap)
    expect(cacheMap.size).toBeGreaterThan(0)
    expect(pkgUIConfigMap.size).toBeGreaterThan(0)
    expect(urlCache.size).toBeGreaterThan(0)
    expect(rootPkgCache.size).toBeGreaterThan(0)

    clearUICache()

    expect(cacheMap.size).toBe(0)
    expect(pkgUIConfigMap.size).toBe(0)
    expect(urlCache.size).toBe(0)
    expect(rootPkgCache.size).toBe(0)
  })
})
