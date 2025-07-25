import type * as vscode from 'vscode'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'
import { getConfiguration } from '@vscode-use/utils'
import { findUp } from 'find-up'
import { nameMap } from './constants'
// import { componentsReducer, propsReducer } from './ui/utils'
import type { ComponentOptions, PropsOptions } from './ui/utils'

export interface UIconfig {
  getPropsConfig: (context: vscode.ExtensionContext, lang: string) => Promise<PropsOptions>
  getUiCompletions: (context: vscode.ExtensionContext, lang: string) => Promise<ComponentOptions>
}

/**
 * @description 获取是否显示插槽配置
 */
export const getIsShowSlots = () => getConfiguration('common-intellisense.showSlots')
/**
 * @description 获取组件别名配置
 */
export const getAlias = () => getConfiguration('common-intellisense.alias') as Record<string, string>
/**
 * @description 获取组件前缀配置
 */
export const getPrefix = () => getConfiguration('common-intellisense.prefix') as Record<string, string>
/**
 * @description 获取运行组件配置
 */
export const getSelectedUIs = () => getConfiguration('common-intellisense.ui') as string[]

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
    const uiConfigObject = await import(`file://${resolve(mainPath, configPath)}`)
    return {
      ...uiConfigObject,
    }
  }
  catch { }
}
