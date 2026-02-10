import type * as vscode from 'vscode'
import type { OptionsComponents, PropsConfig, Uis } from './types'
import fsp from 'node:fs/promises'
import { createLog, getActiveText, getCurrentFileUrl, getRootPath, watchFile } from '@vscode-use/utils'
import { findUp } from 'find-up'
import { UINames as configUINames } from '../constants'
import { cacheFetch, fetchFromCommonIntellisense, fetchFromLocalUris, fetchFromRemoteNpmUrls, fetchFromRemoteUrls, getLocalCache, localCacheUri } from '../services/fetch'
import { formatUIName, getAlias, getIsShowSlots, getPrefix, getSelectedUIs, getUiDeps } from './ui-utils'
import { cacheMap, pkgUIConfigMap, rootPkgCache, urlCache } from '../services/ui-cache'
import path from 'node:path'
import { getLibVersion } from 'get-lib-version'
import { clearTypeCache } from '../type-extract/cache'

export const logger = createLog('common-intellisense')
const UI: Record<string, () => any> = {}
const UINames: string[] = []
let optionsComponents: OptionsComponents = { prefix: [], data: [], directivesMap: {}, libs: [] }
let UiCompletions: PropsConfig | null = null
let currentPkgUiNames: null | string[] = null
// urlCache is now provided by services/ui-cache
let stop: (() => void) | null = null
let preUis: Uis | null = null

// cache monorepo/root package info per workspace rootPath to avoid repeatedly
// reading the root package.json in monorepo scenarios. Each entry may also
// hold a single shared watcher for the root package.json. rootPkgCache is provided by services/ui-cache

export async function findUI(extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, cleanCache?: boolean) {
  UINames.length = 0
  optionsComponents = { prefix: [], data: [], directivesMap: {}, libs: [] }
  UiCompletions = null
  currentPkgUiNames = null
  cacheMap.clear()
  pkgUIConfigMap.clear()
  if (cleanCache)
    urlCache.clear()
  if (cleanCache)
    clearTypeCache()
  // defer reading user settings until we locate the package.json for this cwd
  let selectedUIs: string[] = []
  let alias: Record<string, string> = {}
  let prefix: Record<string, string> = {}

  const cwd = getCurrentFileUrl()
  if (!cwd || cwd === 'exthhost')
    return

  if (urlCache.has(cwd)) {
    await getOthers()
    const cached = urlCache.get(cwd)
    if (cached && cached.uis.length) {
      // 从缓存中获取对应的 package.json 路径来读取正确的配置
      selectedUIs = getSelectedUIs(cached.pkg)
      alias = getAlias(cached.pkg)
      prefix = getPrefix(cached.pkg)
      await updateCompletions(cached.uis, { selectedUIs, alias, detectSlots, prefix, pkgPath: cached.pkg })
    }
    return
  }
  const OnChange = () => findUI(extensionContext, detectSlots)

  findPkgUI(cwd, OnChange).then(async (res) => {
    if (!res)
      return
    const { uis, pkg } = res
    // read per-package settings using the package.json path so monorepo subpackages
    // can have independent configuration (common-intellisense.ui/keyed by path)
    selectedUIs = getSelectedUIs(pkg)
    alias = getAlias(pkg)
    prefix = getPrefix(pkg)
    urlCache.set(cwd, { uis, pkg })
    await getOthers()

    if (!uis || !uis.length)
      return

    return updateCompletions(uis, { selectedUIs, alias, detectSlots, prefix, pkgPath: pkg }).then(() => {
      logger.info(`findUI: ${uis.map(ui => ui.join('@')).join(' | ')}`)
    }).catch((error) => {
      logger.info(`updateCompletions获取失败${error?.message || error}`)
    })
  }).catch((error) => {
    logger.info(`findPkgUI获取失败${error?.message || error}`)
  })
}

export interface UpdateCompletionsOptions {
  selectedUIs: string[]
  alias: Record<string, string>
  detectSlots: (...args: any[]) => void
  prefix: Record<string, string>
  pkgPath?: string
}

export async function updateCompletions(
  uis: Uis,
  options: UpdateCompletionsOptions,
) {
  const { selectedUIs, alias, detectSlots, prefix: userPrefix, pkgPath } = options
  if (!preUis) {
    preUis = uis
  }
  else if (UiCompletions && (preUis.join('') === uis.join(''))) {
    currentPkgUiNames = uis.map(([name]) => name)
  }
  else {
    preUis = uis
  }
  // 读取本地缓存
  await getLocalCache
  // 获取远程的 UI 库
  const uisName: string[] = []
  const originUisName: string[] = []
  const formatToPkg = new Map<string, { pkgName: string, version: string }>()
  for await (let [uiName, version] of uis) {
    let _version = version.match(/[^~]?(\d+)./)![1]

    if (uiName in alias) {
      const v = alias[uiName]
      const m = v.match(/([^1-9^]+)\^?(\d)/)!
      _version = m[2] || _version
      const originName = `${uiName}${_version}`
      if (selectedUIs.length) {
        // 如果 selectedUIs 有值
        if (!(originName in selectedUIs))
          continue
      }
      originUisName.push(originName)
      uiName = m[1]
    }
    else {
      originUisName.push(`${uiName}${_version}`)
    }
    const formatName = `${formatUIName(uiName)}${_version}`
    formatToPkg.set(formatName, { pkgName: uiName, version: _version })
    uisName.push(formatName)
  }

  if (selectedUIs && selectedUIs.length && !selectedUIs.includes('auto')) {
    UINames.push(...selectedUIs.filter(item => uisName.includes(item)))
    // if no selected UI names match, don't overwrite user's config here; leave existing selection intact
  }

  if (!UINames.length)
    UINames.push(...uisName)

  currentPkgUiNames = uisName
  optionsComponents = { prefix: [], data: [], directivesMap: {}, libs: [] }

  await Promise.all(UINames.map(async (name: string) => {
    let componentsNames
    const key = `${name}Components`
    if (cacheMap.has(key)) {
      componentsNames = cacheMap.get(key)
    }
    else {
      try {
        const pkgInfo = formatToPkg.get(name)
        Object.assign(UI, await fetchFromCommonIntellisense(
          name.replace(/([A-Z])/g, '-$1').toLowerCase(),
          pkgInfo ? { pkgName: pkgInfo.pkgName, uiName: name, resolveFrom: pkgPath } : { uiName: name, resolveFrom: pkgPath },
        ))
        componentsNames = UI[key]?.()
        cacheMap.set(key, componentsNames)
      }
      catch (error) {
        logger.error(`fetch fetchFromCommonIntellisense [${name}] error： ${String(error)}`)
      }
    }
    if (componentsNames) {
      for (const componentsName of componentsNames) {
        let { prefix, data, directives, lib } = componentsName
        // use custom prefix first
        if (userPrefix && userPrefix[lib]) {
          prefix = userPrefix[lib]
        }
        if (optionsComponents.libs.includes(lib) && optionsComponents.prefix.includes(prefix))
          continue
        optionsComponents.libs.push(lib)
        if (!optionsComponents.prefix.includes(prefix))
          optionsComponents.prefix.push(prefix)
        optionsComponents.data.push(data)
        const libWithVersion = originUisName.find(item => item.startsWith(lib))!
        optionsComponents.directivesMap[libWithVersion] = directives
      }
    }
    let completion
    if (cacheMap.has(name)) {
      completion = cacheMap.get(name)
    }
    else {
      completion = await UI[name]?.()
      cacheMap.set(name, completion)
    }
    if (!UiCompletions)
      UiCompletions = {}

    Object.assign(UiCompletions, completion)
  }))

  try {
    await fsp.writeFile(localCacheUri, JSON.stringify(Array.from(cacheFetch.entries())))
  }
  catch (error) {
    logger.error(`写入${localCacheUri} 失败: ${String(error)}`)
  }

  if (getIsShowSlots()) {
    const activeText = getActiveText()
    if (activeText)
      detectSlots(UiCompletions, getUiDeps(activeText), optionsComponents.prefix)
  }
}

// TODO: 找到依赖包的package.json里面带有本插件相关的配置文件并且读取
export async function findPkgUI(cwd?: string, onChange?: () => void) {
  const alias = getAlias()
  if (!cwd)
    return

  const pkg = await findUp('package.json', { cwd })
  if (!pkg)
    return
  if (stop)
    stop()
  // watch package.json (and root package.json when in monorepo)
  // We'll set `stop` to a function that stops all watchers
  // Read package.json for the current package
  const pkgDir = path.resolve(pkg, '..')

  // determine if repository root should be included (monorepo)
  let isMonorepo = false
  let rootPkgPath = ''
  let rootPkg: any = null
  const rootPath = getRootPath()
  // Use cache per rootPath to avoid re-reading root package.json repeatedly.
  if (rootPath) {
    const cached = rootPkgCache.get(rootPath)
    if (cached) {
      ({ rootPkgPath, rootPkg, isMonorepo } = cached)
    }
    else {
      try {
        rootPkgPath = path.resolve(rootPath || '', 'package.json')
        if (rootPkgPath && rootPkgPath !== pkg) {
          try {
            rootPkg = JSON.parse(await fsp.readFile(rootPkgPath, 'utf-8'))
            if (rootPkg && (rootPkg.workspaces || (rootPkg.pnpm && rootPkg.pnpm.workspaces))) {
              isMonorepo = true
            }
            else {
              try {
                await fsp.access(path.resolve(rootPath, 'pnpm-workspace.yaml'))
                isMonorepo = true
              }
              catch { }
            }
          }
          catch { }
        }
      }
      catch { }

      rootPkgCache.set(rootPath, { rootPkgPath, rootPkg, isMonorepo })
    }
  }

  if (onChange) {
    const stopMain = watchFile(pkg, { onChange })
    // if monorepo and we have a distinct root package, ensure there's a single
    // watcher for the root package.json shared across calls for this rootPath.
    if (isMonorepo && rootPkgPath && rootPkgPath !== pkg && rootPath) {
      const cached = (rootPkgCache.get(rootPath) ?? {}) as { rootPkgPath?: string, rootPkg?: any, isMonorepo?: boolean, stopRoot?: () => void }
      if (!cached.stopRoot) {
        const stopRoot = watchFile(rootPkgPath, { onChange })
        cached.stopRoot = stopRoot
        rootPkgCache.set(rootPath, { rootPkgPath: rootPkgPath || '', rootPkg: rootPkg || null, isMonorepo: !!isMonorepo, stopRoot: cached.stopRoot })
      }

      stop = () => {
        try { stopMain && stopMain() }
        catch { }
        // do not stop the shared root watcher here; it lives in the cache until
        // the extension deactivates or the workspace changes. This prevents
        // installing/removing watchers on repeated calls inside the same root.
      }
    }
    else {
      stop = stopMain
    }
  }

  const p = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
  const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = p
  const result: Uis = []
  const aliasUiNames = Object.keys(alias)
  // build deps map; include root deps when monorepo. local package deps override root deps.
  const rootDependencies = (rootPkg && (rootPkg.dependencies || rootPkg.devDependencies || rootPkg.peerDependencies)) ? { ...(rootPkg.dependencies || {}), ...(rootPkg.peerDependencies || {}), ...(rootPkg.devDependencies || {}) } : {}
  const deps = { ...rootDependencies, ...dependencies, ...peerDependencies, ...devDependencies }
  // record source dir for each dependency so getLibVersion can resolve correctly
  const depSource: Record<string, string> = {}
  for (const k in rootDependencies)
    depSource[k] = path.resolve(rootPath || '', '.')
  for (const k in dependencies)
    depSource[k] = pkgDir
  for (const k in peerDependencies)
    depSource[k] = pkgDir
  for (const k in devDependencies)
    depSource[k] = pkgDir

  for (const key in deps) {
    if (configUINames.includes(key) || aliasUiNames.includes(key)) {
      const version = deps[key]
      // 处理 workspace:、catelog:、npm:、catalog: 等前缀
      const matched = version.match(/^(workspace:|catelog:|npm:|catalog:)(.*)$/)
      let fixedVersion = version
      if (matched) {
        const suffix = (matched[2] || '').trim()
        // 如果后缀本身就是语义化版本（例如 workspace:^2.0.0 或 workspace:2.0.0），直接使用后缀
        const isSemverLike = !!suffix && /^[~^]?\d.*$/.test(suffix)
        if (isSemverLike) {
          fixedVersion = suffix.match(/^[~^]?(\d+(?:\.\d+){0,2})/)[1]
        }
        else {
          // resolve from the package that declares the dependency if possible
          const resolveFrom = depSource[key] || pkgDir || path.resolve(pkg, '..')
          fixedVersion = await getLibVersion(key, resolveFrom)
        }
      }
      if (!fixedVersion) {
        logger.error(`${key} version is wrong: ${version}`)
        return
      }
      result.push([key, fixedVersion])
    }
  }
  return { pkg, uis: result }
}

export { deactivateUICache, getCacheMap, urlCache } from '../services/ui-cache'

export function getCurrentPkgUiNames() {
  return currentPkgUiNames
}

export function getOptionsComponents() {
  return optionsComponents
}

export function getUiCompletions() {
  return UiCompletions
}

// getCacheMap is re-exported from services/ui-cache

async function getOthers() {
  try {
    const others = Object.assign({}, ...await Promise.all([fetchFromLocalUris(), fetchFromRemoteUrls(), fetchFromRemoteNpmUrls()]))

    Object.assign(UI, others)

    if (Object.keys(UI).length) {
      for (const key in UI) {
        if (key.endsWith('Components')) {
          const componentsNames = UI[key]?.()
          if (!componentsNames)
            continue
          for (const componentsName of componentsNames) {
            const { prefix, data, directives, lib } = componentsName
            if (optionsComponents.libs.includes(lib))
              continue
            optionsComponents.libs.push(lib)
            if (!optionsComponents.prefix.includes(prefix))
              optionsComponents.prefix.push(prefix)
            optionsComponents.data.push(data)
            const libWithVersion = key.slice(0, -'Components'.length)
            optionsComponents.directivesMap[libWithVersion] = directives
          }
          cacheMap.set(key, componentsNames)
        }
        else if (UI[key]) {
          const completion = await UI[key]()
          if (!completion)
            continue
          if (!UiCompletions)
            UiCompletions = {}
          cacheMap.set(key, completion)
        }
      }
    }
  }
  catch (error) {
    logger.error(`getOthers error: ${String(error)}`)
  }
}
