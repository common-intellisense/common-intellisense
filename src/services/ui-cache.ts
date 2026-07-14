import type { ComponentsConfig, PropsConfig, Uis } from '../ui/types'
import { clearPackageVersionCache } from './package-version'

export const cacheMap = new Map<string, ComponentsConfig | PropsConfig>()
export const pkgUIConfigMap = new Map<string, { propsConfig: PropsConfig, componentsConfig: ComponentsConfig }>()
export const urlCache = new Map<string, { uis: Uis, pkg: string }>()
export interface RootPackageCacheEntry {
  rootPkgPath: string
  rootPkg: any
  isMonorepo: boolean
  stopRoot?: () => void
  stopWorkspace?: () => void
  subscribers?: Map<string, () => void>
}

export const rootPkgCache = new Map<string, RootPackageCacheEntry>()

export function removeRootPackageSubscriber(packagePath: string) {
  for (const value of rootPkgCache.values())
    value.subscribers?.delete(packagePath)
}

export function disposeRootPackageCache(workspaceRoot: string) {
  const value = rootPkgCache.get(workspaceRoot)
  if (!value)
    return
  try { value.stopRoot?.() }
  catch {}
  try { value.stopWorkspace?.() }
  catch {}
  value.subscribers?.clear()
  rootPkgCache.delete(workspaceRoot)
}

export function invalidateRootPackageCacheForManifest(manifestPath: string) {
  for (const [rootPath, value] of rootPkgCache) {
    if (value.rootPkgPath !== manifestPath)
      continue
    try { value.stopRoot?.() }
    catch {}
    try { value.stopWorkspace?.() }
    catch {}
    value.subscribers?.clear()
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
    value.subscribers?.clear()
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
