import type * as vscode from 'vscode'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { getConfiguration } from '@vscode-use/utils'
import { findUp } from 'find-up'
import ts from 'typescript'
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizePackageRecordConfiguration(raw: unknown, pkgPath?: string): Record<string, string> {
  if (!isRecord(raw))
    return {}

  if (pkgPath && Object.prototype.hasOwnProperty.call(raw, pkgPath)) {
    const scoped = raw[pkgPath]
    if (isRecord(scoped))
      return Object.fromEntries(Object.entries(scoped).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    return {}
  }

  // A record-valued entry identifies the package-scoped shape. Never leak that
  // outer package-path mapping to callers expecting an alias/prefix map.
  if (Object.values(raw).some(isRecord))
    return {}

  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** @description 获取组件别名配置，支持按 package.json 路径区分的配置映射 */
export function getAlias(pkgPath?: string): Record<string, string> {
  return normalizePackageRecordConfiguration(getConfiguration('common-intellisense.alias'), pkgPath)
}

/** @description 获取组件前缀配置，支持按 package.json 路径区分的配置映射 */
export function getPrefix(pkgPath?: string): Record<string, string> {
  return normalizePackageRecordConfiguration(getConfiguration('common-intellisense.prefix'), pkgPath)
}

/** @description 获取运行组件配置，支持按 package.json 路径区分的配置映射 */
export function normalizeSelectedUIs(raw: unknown, pkgPath?: string): string[] {
  if (Array.isArray(raw))
    return raw.filter((value): value is string => typeof value === 'string')
  if (pkgPath && isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, pkgPath)) {
    const scoped = raw[pkgPath]
    return Array.isArray(scoped)
      ? scoped.filter((value): value is string => typeof value === 'string')
      : ['auto']
  }
  return ['auto']
}

export function getSelectedUIs(pkgPath?: string): string[] {
  return normalizeSelectedUIs(getConfiguration('common-intellisense.ui'), pkgPath)
}

const uiImportedNames = new WeakMap<Record<string, string>, Record<string, string>>()

export function getUiImportedName(deps: Record<string, string> | undefined, localName: string) {
  return deps ? uiImportedNames.get(deps)?.[localName] || localName : localName
}

export function getUiDeps(text: string) {
  if (!text)
    return
  const deps: Record<string, string> = {}
  const importedNames: Record<string, string> = {}
  const scriptBlocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1])
  const sourceText = scriptBlocks.length ? scriptBlocks.join('\n') : text
  const sourceFile = ts.createSourceFile('component.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly)
      continue
    const from = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (!clause)
      continue
    if (clause.name) {
      deps[clause.name.text] = from
      // A default import's local identifier is also the component name used in
      // templates/JSX; only named aliases need remapping to an imported name.
      importedNames[clause.name.text] = clause.name.text
    }
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      deps[bindings.name.text] = from
      importedNames[bindings.name.text] = '*'
    }
    else if (bindings) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) {
          deps[element.name.text] = from
          importedNames[element.name.text] = element.propertyName?.text || element.name.text
        }
      }
    }
  }
  uiImportedNames.set(deps, importedNames)
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
  if (tagname.includes('.')) {
    const parts = tagname.split('.').filter(Boolean).map((part) => {
      let value = part
      if (value.includes('-'))
        value = toCamel(value)
      if (!value)
        return ''
      if (value[0] === value[0].toLowerCase())
        value = value[0].toUpperCase() + value.slice(1)
      return value
    }).filter(Boolean)
    if (parts.length)
      return parts.join('')
  }
  if (tagname.includes('-')) {
    return tagname[0].toUpperCase() + tagname.replace(/(-\w)/g, (match: string) => match[1].toUpperCase()).slice(1)
  }
  const camel = toCamel(tagname)
  if (camel && /[A-Z]/.test(camel) && camel[0] === camel[0].toLowerCase())
    return camel[0].toUpperCase() + camel.slice(1)
  return camel
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
