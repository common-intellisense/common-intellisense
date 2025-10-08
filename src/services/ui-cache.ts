import type { ComponentsConfig, PropsConfig, Uis } from '../ui/types'

export const cacheMap = new Map<string, ComponentsConfig | PropsConfig>()
export const pkgUIConfigMap = new Map<string, { propsConfig: PropsConfig, componentsConfig: ComponentsConfig }>()
export const urlCache = new Map<string, { uis: Uis, pkg: string }>()
export const rootPkgCache: Map<string, { rootPkgPath: string, rootPkg: any, isMonorepo: boolean, stopRoot?: () => void }> = new Map()

export function clearUICache() {
  cacheMap.clear()
  pkgUIConfigMap.clear()
  urlCache.clear()
  rootPkgCache.clear()
}

export function getCacheMap() {
  return cacheMap
}

export function deactivateUICache() {
  clearUICache()
}
