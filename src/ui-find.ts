import fsp from 'node:fs/promises'
import { findUp } from 'find-up'
import { createLog, getActiveText, getCurrentFileUrl, setConfiguration, watchFiles } from '@vscode-use/utils'
import type * as vscode from 'vscode'
import { UINames as configUINames } from './constants'
import { formatUIName, getAlias, getIsShowSlots, getSelectedUIs, getUiDeps } from './ui-utils'
import type { ComponentsConfig, Directives, PropsConfig, SubCompletionItem } from './ui/utils'
import { cacheFetch, fetchFromCommonIntellisense, fetchFromRemoteNpmUrls, fetchFromRemoteUrls, getLocalCache, localCacheUri } from './fetch'

export interface OptionsComponents {
  prefix: string[]
  data: (() => vscode.CompletionItem[])[]
  directivesMap: Record<string, Directives | undefined>
}
export type Uis = [string, string][]

export const logger = createLog('common-intellisense')
const UI: Record<string, () => any> = {}
const UINames: string[] = []
let optionsComponents: OptionsComponents = { prefix: [], data: [], directivesMap: {} }
let UiCompletions: PropsConfig | null = null
const cacheMap = new Map<string, ComponentsConfig | PropsConfig>()
const pkgUIConfigMap = new Map<string, { propsConfig: PropsConfig, componentsConfig: ComponentsConfig }>()
export const eventCallbacks = new Map<string, SubCompletionItem[]>()
export const completionsCallbacks = new Map<string, SubCompletionItem[]>()
let currentPkgUiNames: null | string[] = null
// const filters = ['js', 'ts', 'jsx', 'tsx', 'vue', 'svelte']
export const urlCache = new Map<string, Uis>()
let stop: any = null
let preUis: Uis | null = null

export function findUI(extensionContext: vscode.ExtensionContext, detectSlots: any) {
  UINames.length = 0
  optionsComponents = { prefix: [], data: [], directivesMap: {} }
  UiCompletions = null
  eventCallbacks.clear()
  completionsCallbacks.clear()
  currentPkgUiNames = null
  cacheMap.clear()
  pkgUIConfigMap.clear()
  urlCache.clear()
  const selectedUIs = getSelectedUIs()
  const alias = getAlias()

  const cwd = getCurrentFileUrl()
  if (!cwd || cwd === 'exthhost')
    return

  if (urlCache.has(cwd)) {
    const uis = urlCache.get(cwd)
    if (uis && uis.length)
      updateCompletions(uis)
    return
  }
  const OnChange = () => findUI(extensionContext, detectSlots)

  findPkgUI(cwd, OnChange).then((res) => {
    if (!res)
      return
    const { uis } = res
    urlCache.set(cwd, uis)
    if (!uis || !uis.length)
      return
    return updateCompletions(uis).then(() => {
      logger.info(`findUI: ${uis}`)
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
    Object.assign(uis, await fetchFromRemoteUrls(), await fetchFromRemoteNpmUrls())
    const uisName: string[] = []
    const originUisName: string[] = []
    for await (let [uiName, version] of uis) {
      let _version = version.match(/[^~]?(\d+)./)![1]
      if (uiName in alias) {
        const v = alias[uiName]
        const m = v.match(/([^1-9^]+)\^?(\d)/)!
        _version = m[2]
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
    optionsComponents = { prefix: [], data: [], directivesMap: {} }
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
        completion = UI[name]?.()
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
    stop = watchFiles(pkg, { onChange })
  const p = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
  const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = p
  const result: Uis = []
  const aliasUiNames = Object.keys(alias)
  const deps = { ...dependencies, ...peerDependencies, ...devDependencies }
  for (const key in deps) {
    if (configUINames.includes(key) || aliasUiNames.includes(key))
      result.push([key, deps[key]])
  }
  return { pkg, uis: result }
}

export function deactivateUICache() {
  UINames.length = 0
  optionsComponents = { prefix: [], data: [], directivesMap: {} }
  UiCompletions = null
  cacheMap.clear()
  pkgUIConfigMap.clear()
  urlCache.clear()
  eventCallbacks.clear()
  completionsCallbacks.clear()
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
