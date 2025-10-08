import type * as vscode from 'vscode'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { getConfiguration } from '@vscode-use/utils'
import { findUp } from 'find-up'
import { nameMap } from '../constants'
import { toCamel } from '../ui/utils'
// import { componentsReducer, propsReducer } from './ui/utils'
import type { ComponentOptions, PropsOptions } from '../ui/utils'

export interface UIconfig {
  getPropsConfig: (context: vscode.ExtensionContext, lang: string) => Promise<PropsOptions>
  getUiCompletions: (context: vscode.ExtensionContext, lang: string) => Promise<ComponentOptions>
}

/**
 * @description 获取是否显示插槽配置
 */
export const getIsShowSlots = () => getConfiguration('common-intellisense.showSlots')
/**
 * @description 获取组件别名配置，支持按 package.json 路径区分的配置映射
 * 如果用户配置为对象映射 { [pkgPath]: aliasMap }，则优先返回对应 pkgPath 的值，
 * 否则回退到老的直接返回值（兼容旧配置）
 */
export function getAlias(pkgPath?: string) {
  const raw = getConfiguration('common-intellisense.alias') as any
  if (pkgPath && raw && typeof raw === 'object' && !Array.isArray(raw) && raw[pkgPath])
    return raw[pkgPath] as Record<string, string>
  return raw as Record<string, string>
}
/**
 * @description 获取组件前缀配置，支持按 package.json 路径区分的配置映射
 */
export function getPrefix(pkgPath?: string) {
  const raw = getConfiguration('common-intellisense.prefix') as any
  if (pkgPath && raw && typeof raw === 'object' && !Array.isArray(raw) && raw[pkgPath])
    return raw[pkgPath] as Record<string, string>
  return raw as Record<string, string>
}
/**
 * @description 获取运行组件配置，支持按 package.json 路径区分的配置映射
 */
export function getSelectedUIs(pkgPath?: string) {
  const raw = getConfiguration('common-intellisense.ui') as any
  if (pkgPath && raw && typeof raw === 'object' && !Array.isArray(raw) && raw[pkgPath])
    return raw[pkgPath] as string[]
  return raw as string[]
}

const UIIMPORT_REG = /import\s+\{([^}]+)\}\s+from\s+['"]([^"']+)['"]/g
const UIIMPORTDefault_REG = /import\s+(\S+)\s+from\s+['"]([^"']+)['"]/g
export function getUiDeps(text: string) {
  if (!text)
    return
  text = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
  const deps: Record<string, string> = {}
  for (const match of text.matchAll(UIIMPORT_REG)) {
    if (!match)
      continue
    const from = match[2]
    const _deps = match[1].trim().replace(/\s+/g, ' ').split(/,\s*/).filter(Boolean)
    _deps.forEach((d) => {
      deps[d] = from
    })
  }
  for (const match of text.matchAll(UIIMPORTDefault_REG)) {
    if (!match)
      continue
    const from = match[2]
    const key = match[1]
    deps[key] = from
  }
  return deps
}

const IMPORT_UI_REG = /import\s+\{([^}]+)\}\s+from\s+['"]([^"']+)['"]/g

export function getImportUiComponents(text: string) {
  // 读取需要按需导入的ui库， 例如 antd, 拿出导入的 components
  const deps: Record<string, any> = {}
  for (const match of text.matchAll(IMPORT_UI_REG)) {
    if (!match)
      continue
    const from = match[2]
    deps[from] = {
      match,
      components: match[1].split(',').map(i => i.trim()),
    }
  }
  return deps
}

export function fixedTagName(tagname: string) {
  // 修正 tag 名称
  if (tagname.includes('-')) {
    return tagname[0].toUpperCase() + tagname.replace(/(-\w)/g, (match: string) => match[1].toUpperCase()).slice(1)
  }
  return toCamel(tagname)
}

export function formatUIName(name: string) {
  const uiName = name.replace(/-(\w)/g, (_: string, v: string) => v.toUpperCase())
  return nameMap[uiName] ?? uiName
}
/**
 * @description 动态获取package的依赖是否满足配置
 */
export async function getIntellisenseConfig(name: string, cwd?: string) {
  const require = createRequire(cwd || process.cwd())
  let mainPath = ''
  try {
    mainPath = require.resolve(name)
  }
  catch {
    return
  }
  const pkgJsonPath = await findUp('package.json', { cwd: mainPath })
  if (!pkgJsonPath)
    return
  const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf-8'))

  if (!pkgJson?.['ui-intellisense'])
    return
  const configPath = pkgJson?.['ui-intellisense']
  try {
    const configUrl = pathToFileURL(resolve(mainPath, configPath)).href
    const uiConfigObject = await import(configUrl)
    return {
      ...uiConfigObject,
    }
  }
  catch { }
}
