import type { ComponentsConfig, PropsConfig, Uis } from '../ui/types'
import { clearPackageVersionCache } from './package-version'

export const cacheMap = new Map<string, ComponentsConfig | PropsConfig>()
export const pkgUIConfigMap = new Map<string, { propsConfig: PropsConfig, componentsConfig: ComponentsConfig }>()
export const urlCache = new Map<string, { uis: Uis, pkg: string }>()
export const rootPkgCache: Map<string, { rootPkgPath: string, rootPkg: any, isMonorepo: boolean, stopRoot?: () => void, stopWorkspace?: () => void }> = new Map()

export function invalidateRootPackageCacheForManifest(manifestPath: string) {
  for (const [rootPath, value] of rootPkgCache) {
    if (value.rootPkgPath !== manifestPath)
      continue
    try { value.stopRoot?.() }
    catch {}
    try { value.stopWorkspace?.() }
    catch {}
    rootPkgCache.delete(rootPath)
  }
}

export function disposeRootWatchers() {
  for (const value of rootPkgCache.values()) {
    try { value.stopRoot?.() }
    catch {}
    try { value.stopWorkspace?.() }
    catch {}
    value.stopRoot = undefined
    value.stopWorkspace = undefined
  }
}

export function clearUICache() {
  disposeRootWatchers()
  cacheMap.clear()
  pkgUIConfigMap.clear()
  urlCache.clear()
  rootPkgCache.clear()
  clearPackageVersionCache()
}

export function getCacheMap() {
  return cacheMap
}

export function deactivateUICache() {
  clearUICache()
}
