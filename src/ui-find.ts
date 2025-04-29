import type * as vscode from 'vscode'
import type { ComponentsConfig, Directives, PropsConfig } from './ui/utils'
import fsp from 'node:fs/promises'
import { createLog, getActiveText, getCurrentFileUrl, setConfiguration, watchFile } from '@vscode-use/utils'
import { findUp } from 'find-up'
import { UINames as configUINames } from './constants'
import { cacheFetch, fetchFromCommonIntellisense, fetchFromLocalUris, fetchFromRemoteNpmUrls, fetchFromRemoteUrls, getLocalCache, localCacheUri } from './fetch'
import { formatUIName, getAlias, getIsShowSlots, getSelectedUIs, getUiDeps } from './ui-utils'
import yaml from 'js-yaml'
import path from 'node:path'

export interface OptionsComponents {
  prefix: string[]
  data: ((parent?: any) => vscode.CompletionItem[])[]
  directivesMap: Record<string, Directives | undefined>
  libs: string[]
}
export type Uis = [string, string][]

export const logger = createLog('common-intellisense')
const UI: Record<string, () => any> = {}
const UINames: string[] = []
let optionsComponents: OptionsComponents = { prefix: [], data: [], directivesMap: {}, libs: [] }
let UiCompletions: PropsConfig | null = null
const cacheMap = new Map<string, ComponentsConfig | PropsConfig>()
const pkgUIConfigMap = new Map<string, { propsConfig: PropsConfig, componentsConfig: ComponentsConfig }>()
let currentPkgUiNames: null | string[] = null
// const filters = ['js', 'ts', 'jsx', 'tsx', 'vue', 'svelte']
export const urlCache = new Map<string, Uis>()
let stop: any = null
let preUis: Uis | null = null

export async function findUI(extensionContext: vscode.ExtensionContext, detectSlots: any, cleanCache?: boolean) {
  UINames.length = 0
  optionsComponents = { prefix: [], data: [], directivesMap: {}, libs: [] }
  UiCompletions = null
  currentPkgUiNames = null
  cacheMap.clear()
  pkgUIConfigMap.clear()
  if (cleanCache)
    urlCache.clear()
  const selectedUIs = getSelectedUIs()
  const alias = getAlias()

  const cwd = getCurrentFileUrl()
  if (!cwd || cwd === 'exthhost')
    return

  if (urlCache.has(cwd)) {
    await getOthers()
    const uis = urlCache.get(cwd)
    if (uis && uis.length)
      updateCompletions(uis)
    return
  }
  const OnChange = () => findUI(extensionContext, detectSlots)

  findPkgUI(cwd, OnChange).then(async (res) => {
    if (!res)
      return
    const { uis } = res
    urlCache.set(cwd, uis)
    await getOthers()

    if (!uis || !uis.length)
      return

    return updateCompletions(uis).then(() => {
      logger.info(`findUI: ${uis.map(ui => ui.join('@')).join(' | ')}`)
    }).catch((error) => {
      logger.info(`updateCompletions获取失败${error?.message || error}`)
    })
  }).catch((error) => {
    logger.info(`findPkgUI获取失败${error?.message || error}`)
  })
  async function updateCompletions(uis: Uis) {
    if (!preUis) {
      preUis = uis
    }
    else if (UiCompletions && (preUis.join('') === uis.join(''))) {
      return
    }
    else {
      preUis = uis
    }
    // 读取本地缓存
    await getLocalCache
    // 获取远程的 UI 库
    const uisName: string[] = []
    const originUisName: string[] = []
    for await (let [uiName, version] of uis) {
      let _version = version.match(/[^~]?(\d+)./)![1]
      if (uiName in alias) {
        const v = alias[uiName]
        const m = v.match(/([^1-9^]+)\^?(\d)/)!
        _version = m[2] || _version
        originUisName.push(`${uiName}${_version}`)
        uiName = m[1]
      }
      else {
        originUisName.push(`${uiName}${_version}`)
      }
      const formatName = `${formatUIName(uiName)}${_version}`
      uisName.push(formatName)
    }

    if (selectedUIs && selectedUIs.length && !selectedUIs.includes('auto')) {
      UINames.push(...selectedUIs.filter(item => uisName.includes(item)))
      if (!UINames.length)
        setConfiguration('common-intellisense.ui', [])
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
          Object.assign(UI, await fetchFromCommonIntellisense(name.replace(/([A-Z])/g, '-$1').toLowerCase()))
          componentsNames = UI[key]?.()
          cacheMap.set(key, componentsNames)
        }
        catch (error) {
          logger.error(`fetch fetchFromCommonIntellisense [${name}] error： ${String(error)}`)
        }
      }
      if (componentsNames) {
        for (const componentsName of componentsNames) {
          const { prefix, data, directives, lib } = componentsName
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
      fsp.writeFile(localCacheUri, JSON.stringify(Array.from(cacheFetch.entries())))
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
  if (onChange)
    stop = watchFile(pkg, { onChange })
  const p = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
  const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = p
  const result: Uis = []
  const aliasUiNames = Object.keys(alias)
  const deps = { ...dependencies, ...peerDependencies, ...devDependencies }

  // workspace version map
  const workspaceVersionMap: Record<string, string> = {}
  async function getWorkspaceVersion(pkgName: string): Promise<string | undefined> {
    if (Object.keys(workspaceVersionMap).length === 0) {
      // 查找 pnpm-workspace.yaml
      const workspaceYamlPath = await findUp('pnpm-workspace.yaml', { cwd: path.dirname(pkg!) })
      if (workspaceYamlPath) {
        try {
          const yamlContent = await fsp.readFile(workspaceYamlPath, 'utf-8')
          const workspaceConfig = yaml.load(yamlContent) as any
          // 这里假设你有 monorepo 的 packages 目录，实际情况可能需要更复杂的逻辑
          if (workspaceConfig?.packages && Array.isArray(workspaceConfig.packages)) {
            for (const pattern of workspaceConfig.packages) {
              // 查找所有匹配的 package.json
              const dirs = await findWorkspaceDirs(pattern, path.dirname(workspaceYamlPath))
              for (const dir of dirs) {
                try {
                  const pkgJsonPath = path.join(dir, 'package.json')
                  const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf-8'))
                  if (pkgJson.name && pkgJson.version)
                    workspaceVersionMap[pkgJson.name] = pkgJson.version
                }
                catch { }
              }
            }
          }
        }
        catch { }
      }
    }
    return workspaceVersionMap[pkgName]
  }

  async function getCatalogVersion(catalogName: string, pkgName: string): Promise<string | undefined> {
    const workspaceYamlPath = await findUp('pnpm-workspace.yaml', { cwd: path.dirname(pkg!) })
    if (workspaceYamlPath) {
      try {
        const yamlContent = await fsp.readFile(workspaceYamlPath, 'utf-8')
        const workspaceConfig = yaml.load(yamlContent) as any
        if (workspaceConfig?.catalogs && workspaceConfig.catalogs[catalogName]) {
          return typeof workspaceConfig.catalogs[catalogName] === 'string' ? workspaceConfig.catalogs[catalogName] : workspaceConfig.catalogs[catalogName][pkgName]
        }
      }
      catch { }
    }
    return undefined
  }

  // 简单 glob 匹配 workspace packages
  async function findWorkspaceDirs(pattern: string, root: string): Promise<string[]> {
    // 这里只处理最常见的 packages/* 形式
    if (pattern.endsWith('/*')) {
      const dir = path.join(root, pattern.slice(0, -2))
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        return entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name))
      }
      catch {
        return []
      }
    }
    // 其他情况可扩展
    return []
  }

  for (const key in deps) {
    if (configUINames.includes(key) || aliasUiNames.includes(key)) {
      let version = deps[key]
      // 处理 workspace:、catelog:、npm:、catalog: 等前缀
      const matched = version.match(/^(workspace:|catelog:|npm:|catalog:)(.*)$/)
      if (matched) {
        let realVersion = matched[2].trim()
        // 如果 realVersion 已经包含了 @ 或 ^ 或 ~ 之类的版本号，则直接用，不再查 pnpm-workspace.yaml
        if (
          realVersion
          && /[@~^0-9]/.test(realVersion)
        ) {
          // 直接使用 realVersion
          realVersion = realVersion.match(/[@~^](\d.+)/)[1]
        }
        else if (matched[1] === 'catalog:') {
          // catalog:frontend 需要查找 pnpm-workspace.yaml 的 catalogs
          const catalogName = realVersion || key
          const catalogVersion = await getCatalogVersion(catalogName, key)
          if (catalogVersion)
            realVersion = catalogVersion
        }
        else if (!realVersion) {
          // 没有指定版本，尝试从 workspace 里查找
          const wsVersion = await getWorkspaceVersion(key)
          if (wsVersion)
            realVersion = wsVersion
        }
        if (!realVersion) {
          logger.error(`Not found ${key} version`)
        }
        version = realVersion || version
      }
      result.push([key, version])
    }
  }
  return { pkg, uis: result }
}

export function deactivateUICache() {
  UINames.length = 0
  optionsComponents = { prefix: [], data: [], directivesMap: {}, libs: [] }
  UiCompletions = null
  cacheMap.clear()
  pkgUIConfigMap.clear()
  urlCache.clear()
  Object.entries(UI).forEach(([key]) => {
    delete UI[key]
  })
}

export function getCurrentPkgUiNames() {
  return currentPkgUiNames
}

export function getOptionsComponents() {
  return optionsComponents
}

export function getUiCompletions() {
  return UiCompletions
}

export function getCacheMap() {
  return cacheMap
}

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
          Object.assign(UiCompletions, completion)
        }
      }
    }
    try {
      await fsp.writeFile(localCacheUri, JSON.stringify(Array.from(cacheFetch.entries())))
    }
    catch (error) {
      logger.error(`写入${localCacheUri} 失败: ${String(error)}`)
    }
  }
  catch (error) {
    logger.error(`fetch error： ${String(error)}`)
  }
}
