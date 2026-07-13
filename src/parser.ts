import type { SFCTemplateBlock } from '@vue/compiler-sfc'
import type { VineCompilerHooks, VineDiagnostic, VineFileCtx } from '@vue-vine/compiler'
import type { PropsConfig, PropsConfigItem } from './ui/utils'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as babelParse } from '@babel/parser'
import traverse from '@babel/traverse'
import ts from 'typescript'
import { parse as tsParser } from '@typescript-eslint/typescript-estree'
import { createRange, getActiveText, getActiveTextEditor, getCurrentFileUrl, getLocale, getPosition, getRootPath, isInPosition, registerCodeLensProvider } from '@vscode-use/utils'
// @ts-expect-error no problem
import { parse } from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
import {
  compileVineTypeScriptFile,
  createCompilerCtx,
} from '@vue-vine/compiler'

import * as vscode from 'vscode'
import { nameMap } from './constants'
import { convertPrefixedComponentName, findPrefixedComponent, hyphenate } from './ui/utils'
import { getSourceScope, logger } from './ui/ui-find'
import type { ComponentSourceScope } from './services/component-resolver'
import { isLocalModuleSource, resolveImportedTag, sourceScopeAccepts } from './services/component-resolver'
import { getNodeOffsetRange } from './services/node-range'
import { isNativeTag } from './services/native-tags'
import { getSvelteInstanceScript } from './services/svelte-script'

const { parse: svelteParser } = require('svelte/compiler')

// 引入vue-parser只在template中才处理一些逻辑
let isInTemplate = false
interface VineFileCtxResult {
  vineFileCtx: VineFileCtx
  vineCompileErrs: VineDiagnostic[]
  vineCompileWarns: VineDiagnostic[]
}

const parserCacheLimit = 5
const vueSfcParseCache = new Map<string, ReturnType<typeof parse>>()
const jsxAstCache = new Map<string, any>()
const svelteHtmlCache = new Map<string, any>()
const vineCtxCache = new Map<string, VineFileCtxResult>()
let lineIndexCache: { code: string, starts: number[] } | null = null

function getCached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  if (cache.has(key)) {
    const value = cache.get(key)!
    cache.delete(key)
    cache.set(key, value)
    return value
  }
  const value = create()
  cache.set(key, value)
  while (cache.size > parserCacheLimit)
    cache.delete(cache.keys().next().value!)
  return value
}

function getVueSfcParseResult(code: string) {
  return getCached(vueSfcParseCache, code, () => parse(code))
}

function getJsxAst(code: string) {
  return getCached(jsxAstCache, code, () => tsParser(code, { jsx: true, loc: true, range: true }))
}

function collectJsxElements(node: any, result: any[]) {
  if (!node || typeof node !== 'object')
    return
  if (node.type === 'JSXElement')
    result.push(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range')
      continue
    if (Array.isArray(value)) {
      for (const child of value)
        collectJsxElements(child, result)
    }
    else {
      collectJsxElements(value, result)
    }
  }
}

function getSvelteHtml(code: string) {
  return getCached(svelteHtmlCache, code, () => {
    try {
      return svelteParser(code).html
    }
    catch {
      // Incomplete Svelte is normal while editing; providers must fail closed.
      return undefined
    }
  })
}

export interface ParserDocumentContext {
  languageId?: string
  uri?: string
  offset?: number
}

export function parser(code: string, position: vscode.Position, documentContext: ParserDocumentContext = {}) {
  const entry = documentContext.uri || getCurrentFileUrl()
  const isVineDocument = entry?.endsWith('.vine.ts')
  if (isVineDocument)
    return parserVine(code, position, documentContext.offset ?? getSourceOffset(code, position))

  const languageId = documentContext.languageId
  const suffix = entry?.slice(entry.lastIndexOf('.') + 1)
  if (!suffix && !languageId)
    return
  isInTemplate = false
  if (languageId === 'vue' || suffix === 'vue') {
    const cursorOffset = documentContext.offset ?? getSourceOffset(code, position)
    const result = transformVue(code, position, 0, cursorOffset)
    if (!result)
      return
    if (!result.refs?.length || !result.template)
      return result
    const refsMap = findRefs(result.template, result.refs)
    return Object.assign(result, { refsMap })
  }
  if (['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId || '') || /^(?:ts|js|jsx|tsx)$/.test(suffix || ''))
    return parserJSX(code, position)

  if (languageId === 'svelte' || suffix === 'svelte')
    return parserSvelte(code, position)

  return true
}

function collectVueTemplateRefs(scripts: Array<{ content?: string } | null | undefined>) {
  const refs: (string | [string, string])[] = []
  for (const block of scripts) {
    for (const match of (block?.content || '').matchAll(/(const|let|var)\s+([\w$]+)\s*=\s*(ref|useTemplateRef)[^()]*\(([^)]*)\)/g)) {
      if (match[3] === 'useTemplateRef')
        refs.push([match[2], match[4].slice(1, -1)])
      else
        refs.push(match[2])
    }
  }
  return refs
}

export function transformVue(code: string, position: vscode.Position, offset = 0, cursorOffset = getSourceOffset(code, position)) {
  const {
    descriptor: { template, script, scriptSetup },
    errors,
  } = getVueSfcParseResult(code)

  if (errors.length && !template?.ast)
    return
  const scripts = [script, scriptSetup].filter((block): block is NonNullable<typeof block> => !!block)
  const activeScript = scripts.find(block => isInPosition(block.loc, position, offset))
  const activeScriptLang = activeScript?.lang?.toLowerCase()
  if (activeScript && (activeScriptLang === 'tsx' || activeScriptLang === 'jsx')) {
    const relativeOffset = Math.max(0, Math.min(cursorOffset - activeScript.loc.start.offset, activeScript.content.length))
    const result = parserJSX(activeScript.content, getSourcePosition(activeScript.content, relativeOffset))
    if (result) {
      result.loc = activeScript.loc
      result.template = template
      result.hostFramework = 'vue'
      result.syntax = 'jsx'
      result.vueBlock = activeScript === scriptSetup ? 'scriptSetup' : 'script'
      result.blockLang = activeScript.lang
    }
    return result
  }
  if (activeScript) {
    return {
      type: 'script',
      refs: collectVueTemplateRefs([activeScript]),
      template,
      loc: activeScript.loc,
      vueBlock: activeScript === scriptSetup ? 'scriptSetup' : 'script',
      blockLang: activeScript.lang,
    }
  }
  if (!template)
    return
  if (!errors.length && !isInPosition(template.loc, position, offset))
    return
  // 在template中
  const { ast } = template

  const r = dfs(ast.children, template, position, offset, cursorOffset)
  if (r) {
    const importTarget = scriptSetup || script
    r.loc = importTarget?.loc
    r.vueBlock = scriptSetup ? 'scriptSetup' : script ? 'script' : undefined
    r.blockLang = importTarget?.lang
    return r
  }
  return r
}

export function transformVine(vineFileCtx: VineFileCtx, position: vscode.Position, cursorOffset?: number) {
  const targetInPositionNode = vineFileCtx.vineCompFns.find(item => item.fnDeclNode.loc ? isInPosition(item.fnDeclNode.loc, position) : false)
  if (!targetInPositionNode)
    return

  const { templateAst, fnDeclNode, templateStringNode } = targetInPositionNode
  const children = templateAst?.children
  if (!children)
    return
  const parent = fnDeclNode
  const templateOffset = templateStringNode?.quasi.quasis[0].start || 0
  const result = dfs(children, parent, position, templateOffset, cursorOffset)
  const refsMap = findRef(children, {})
  if (result)
    return Object.assign(result, { refsMap })

  return {
    type: 'script',
    refsMap,
  }
}

function dfs(children: any, parent: any, position: vscode.Position, offset = 0, cursorOffset?: number) {
  for (const child of children) {
    const { loc, tag, props, children } = child
    if (!isInPosition(loc, position, offset))
      continue

    if (parent) {
      child.parent = parent
    }
    if (tag) {
      const isTag = isInPosition({
        start: loc.start,
        end: {
          line: loc.start.line,
          column: loc.start.column + tag.length,
        },
      }, position, offset)

      if (isTag) {
        return {
          tag,
          props,
          type: 'tag',
          isInTemplate: true,
          parent: {
            tag: parent.tag ? parent.tag : 'template',
            props: parent.props || [],
            parent: parent.parent,
          },
          template: parent,
        }
      }
    }

    if (props && props.length) {
      for (const prop of props) {
        if (isInPosition(prop.loc, position, offset)) {
          if (!isInAttribute(child, position, offset, cursorOffset))
            return false
          if ((prop.name === 'bind' || prop.name === 'on') && prop.exp && isInPosition(prop.exp.loc, position)) {
            return {
              tag,
              propName: prop.exp?.content !== undefined,
              props,
              type: 'props',
              isInTemplate: true,
              isValue: prop.exp?.content !== undefined,
              parent: {
                tag: parent.tag ? parent.tag : 'template',
                props: parent.props || [],
                parent: parent.parent,
              },
              isDynamic: prop.name === 'bind',
              isDynamicArgument: prop.arg?.isStatic === false,
              isEvent: prop.name === 'on',
              template: parent,
            }
          }
          else {
            let propName = prop.name
            const isEvent = propName === 'on'
            if (prop.arg && isInPosition(prop.arg.loc, position)) {
              propName = prop.arg.content
            }
            else if (prop.exp && isInPosition({
              start: {
                line: prop.exp.loc.start.line,
                column: prop.exp.loc.start.column - 1,
              },
              end: prop.exp.loc.end,
            }, position) && prop.arg) {
              propName = prop.arg.content
            }

            return {
              tag,
              propName,
              props,
              type: 'props',
              isInTemplate: true,
              isDynamicArgument: prop.arg?.isStatic === false,
              isEvent,
              isValue: prop.value?.content !== undefined || prop.exp?.content !== undefined,
              parent: {
                tag: parent.tag ? parent.tag : 'template',
                props: parent.props || [],
                parent: parent.parent,
              },
              template: parent,
            }
          }
        }
      }
    }
    if (children && children.length) {
      const result = dfs(children, child, position, offset, cursorOffset) as any
      if (result)
        return result
    }
    if (tag) {
      if (!isInAttribute(child, position, offset))
        return false
      return {
        type: 'props',
        tag,
        props,
        isInTemplate: true,
        parent: {
          tag: parent.tag ? parent.tag : 'template',
          props: parent.props || [],
          parent: parent.parent,
        },
        template: parent,
      }
    }
    if (child.type === 2 || child.content?.type === 2) {
      return {
        type: 'text',
        isInTemplate: true,
        props,
        parent: {
          tag: parent.tag ? parent.tag : 'template',
          props: parent.props || [],
          parent: parent.parent,
        },
        template: parent,
      }
    }
    return
  }
}

export function getReactRefsMap() {
  const code = getActiveText()
  if (!code) {
    return {
      refsMap: {},
      refs: [],
    }
  }
  const ast = getJsxAst(code)
  const children = ast.body
  return findJsxRefs(children)
}

export function parserJSX(code: string, position: vscode.Position) {
  try {
    const ast = getJsxAst(code)
    const children = ast.body
    const result = jsxDfs(children, null, position, code)
    const map = findJsxRefs(children)
    if (result)
      return Object.assign(result, map)

    return {
      type: 'script',
      ...map,
    }
  }
  catch (error) {
    logger.error(String(error))
  }
}

function getJsxElementName(node: any): string | undefined {
  if (!node)
    return
  if (typeof node === 'string')
    return node
  if (typeof node.name === 'string' && (node.type === 'JSXIdentifier' || node.type === 'Identifier' || !node.type))
    return node.name
  if (node.type === 'JSXMemberExpression') {
    const object = getJsxElementName(node.object)
    const property = getJsxElementName(node.property)
    return object && property ? `${object}.${property}` : object || property
  }
  if (node.type === 'JSXNamespacedName') {
    const namespace = getJsxElementName(node.namespace)
    const name = getJsxElementName(node.name)
    return namespace && name ? `${namespace}:${name}` : namespace || name
  }
  return typeof node.name === 'string' ? node.name : undefined
}

function getJsxAttributeName(attribute: any): string | undefined {
  if (!attribute || attribute.type === 'JSXSpreadAttribute')
    return
  if (typeof attribute.name === 'string')
    return attribute.type === 'EventHandler' ? 'on' : attribute.name
  return getJsxElementName(attribute.name)
}

function findOpeningElementEnd(code: string, start = 0, end = code.length) {
  let quote = ''
  let braces = 0
  for (let index = Math.max(0, start); index < Math.min(end, code.length); index++) {
    const char = code[index]
    if (quote) {
      if (char === quote && code[index - 1] !== '\\')
        quote = ''
      continue
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char
      continue
    }
    if (char === '{')
      braces++
    else if (char === '}')
      braces = Math.max(0, braces - 1)
    else if (char === '>' && braces === 0)
      return index + 1
  }
  return Math.min(end, code.length)
}

function jsxDfs(children: any, parent: any, position: vscode.Position, code: string) {
  for (const child of children) {
    let { loc, type, openingElement, body: children, argument, declarations, init } = child
    if (!loc)
      loc = convertPositionToLoc(child, code)
    if (!openingElement && child.attributes) {
      const openingEnd = findOpeningElementEnd(code, child.start, child.end)
      openingElement = {
        name: child.name,
        attributes: child.attributes,
        loc: convertPositionToLoc({ start: child.start, end: openingEnd }, code),
      }
    }
    const openingElementName = getJsxElementName(openingElement?.name) || (typeof child.name === 'string' ? child.name : undefined)
    if (openingElementName)
      child.name = openingElementName

    if (!isInPosition(loc, position))
      continue

    if (parent)
      child.parent = parent

    if (type === 'JSXElement' || type === 'Element' || type === 'InlineComponent' || (type === 'ReturnStatement' && argument && (argument.type === 'JSXElement' || argument.type === 'JSXFragment')))
      isInTemplate = true

    if (openingElement && openingElement.attributes.length) {
      for (const prop of openingElement.attributes) {
        if (!prop.loc)
          prop.loc = convertPositionToLoc(prop, code)
        if (isInPosition(prop.loc, position)) {
          if (prop.type === 'JSXSpreadAttribute' || prop.type === 'Spread') {
            return {
              tag: openingElementName,
              props: openingElement.attributes,
              propType: prop.type,
              type: 'props',
              isInTemplate,
              isValue: false,
              parent,
              isDynamicFlag: true,
              isEvent: false,
            }
          }
          if (prop.value?.type === 'JSXExpressionContainer') {
            children = prop.value.expression
          }
          else {
            return {
              tag: openingElementName,
              propName: getJsxAttributeName(prop),
              props: openingElement.attributes,
              propType: prop.type,
              type: 'props',
              isInTemplate,
              isValue: prop.value
                ? Array.isArray(prop.value)
                  ? prop.value[0]?.raw !== undefined
                  : prop.value.type === 'JSXExpressionContainer'
                    ? prop.value?.expression !== undefined
                    : prop.value?.value !== undefined
                : false,
              parent,
              isDynamicFlag: prop.value?.type === 'JSXExpressionContainer',
              isEvent: prop.type === 'EventHandler' || (prop.type === 'JSXAttribute' && !!getJsxAttributeName(prop)?.startsWith('on')),
            }
          }
        }
      }
    }

    if (children) {
      // skip
    }
    else if (child.children) { children = child.children }
    else if (type === 'ExportNamedDeclaration') { children = child.declaration }
    else if (type === 'ObjectExpression') { children = child.properties }
    else if (type === 'Property' && child.value.type === 'FunctionExpression') { children = child.value.body.body }
    else if (type === 'ExportDefaultDeclaration') {
      children = child.declaration
    }
    else if (type === 'ExpressionStatement') { children = child.expression }
    else if (type === 'JSXExpressionContainer' || type === 'ChainExpression') {
      if (child.expression.type === 'CallExpression') { children = child.expression.arguments }
      else if (child.expression.type === 'ConditionalExpression') {
        children = [
          child.expression.alternate,
          child.expression.consequent,
        ].filter(Boolean)
      }
      else if (child.expression.type === 'LogicalExpression') {
        children = [
          child.expression.left,
          child.expression.right,
        ]
      }
      else { children = child.expression }
    }
    else if (type === 'TemplateLiteral') {
      children = child.expressions
    }
    else if (type === 'ConditionalExpression') {
      children = [
        child.alternate,
        child.consequent,
      ].filter(Boolean)
    }
    else if (type === 'ArrowFunctionExpression') {
      children = child.body
    }
    else if (type === 'VariableDeclaration') { children = declarations }
    else if (type === 'VariableDeclarator') { children = init }
    else if (type === 'ReturnStatement') { children = argument }
    else if (type === 'JSXElement') { children = child.children }
    else if (type === 'ExportNamedDeclaration') { children = child.declaration.body }
    else if (type === 'CallExpression') {
      children = child.arguments
    }
    if (children && !Array.isArray(children))
      children = [children]

    if (children && children.length) {
      const p = ['JSXElement', 'Element', 'InlineComponent'].includes(child.type) ? { ...child, name: openingElementName, props: openingElement?.attributes || [] } : null
      const result = jsxDfs(children, p, position, code) as any
      if (result)
        return result
    }

    if ((type === 'JSXElement' || type === 'Element' || type === 'InlineComponent') && openingElement && isInPosition(openingElement.loc || loc, position)) {
      const target = openingElement.attributes.find((item: any) => isInPosition(item.loc, position))
      if (target) {
        return {
          type: 'props',
          tag: openingElementName,
          props: openingElement.attributes,
          propName: target.type === 'JSXSpreadAttribute' || target.type === 'Spread' ? undefined : getJsxAttributeName(target) || '',
          propType: target.type,
          isDynamicFlag: target.value?.type === 'JSXExpressionContainer',
          isInTemplate,
          isValue: target.value
            ? Array.isArray(target.value)
              ? target.value[0]?.raw !== undefined
              : target.value.type === 'JSXExpressionContainer'
                ? target.value?.expression !== undefined
                : target.value?.value !== undefined
            : false,
          parent,
        }
      }
      const isTag = isInPosition({
        start: loc.start,
        end: {
          line: loc.start.line,
          column: loc.start.column + (child.name || '').length,
        },
      }, position)
      return {
        type: isTag ? 'tag' : 'props',
        tag: openingElementName,
        props: openingElement.attributes,
        isInTemplate,
        parent,
      }
    }

    if (type === 'JSXText' || type === 'Text') {
      return {
        isInTemplate,
        type: 'text',
        props: openingElement?.attributes,
        parent,
      }
    }
    return
  }
}

function findJsxRefs(childrens: any, map: any = {}, refs: any = []) {
  if (!childrens)
    return { refsMap: map, refs }
  for (const child of childrens) {
    let { type, openingElement, body: children, argument, declarations, init, id, expression } = child
    if (child.children) {
      children = child.children
    }
    else if (type === 'VariableDeclaration') {
      children = declarations
    }
    else if (type === 'VariableDeclarator') {
      children = init
      if (init && init.callee && init.callee.name === 'useRef') {
        refs.push(id.name)
        continue
      }
    }
    else if (type === 'ExpressionStatement') {
      children = expression?.arguments || expression
    }
    else if (type === 'ReturnStatement') {
      children = argument
    }
    else if (type === 'JSXElement') {
      children = child.children
    }
    else if (type === 'ExportDefaultDeclaration') {
      children = child.declaration
    }
    else if (!children) {
      continue
    }
    if (children && !Array.isArray(children))
      children = [children]
    if (openingElement && openingElement.attributes.length) {
      for (const prop of openingElement.attributes) {
        if (getJsxAttributeName(prop) === 'ref') {
          const value = prop.value?.expression?.name ?? prop.value?.value
          const tagName = getJsxElementName(openingElement.name)
          if (value && tagName)
            map[value] = transformTagName(tagName)
        }
      }
    }

    if (children && children.length)
      findJsxRefs(children, map, refs)
  }
  return {
    refsMap: map,
    refs,
  }
}

export function findRefs(template: SFCTemplateBlock, refsMap: (string | [string, string])[]) {
  const { ast } = template
  return findRef(ast!.children, {}, refsMap)
}
function findRef(children: any, map: any, refsMap: (string | [string, string])[] = []) {
  for (const child of children) {
    const { tag, props, children } = child
    if (props && props.length) {
      for (const prop of props) {
        const { name, value } = prop
        if (!value)
          continue
        let { content } = value
        if ((name !== 'ref') || !content)
          continue
        for (const r of refsMap) {
          if (Array.isArray(r) && r[1] === content) {
            content = r[0]
          }
        }
        const tagName = transformTagName(tag)
        map[content] = tagName
      }
    }
    if (children && children.length)
      findRef(children, map, refsMap) as any
  }
  return map
}

export function parserSvelte(code: string, position: vscode.Position) {
  const html = getSvelteHtml(code)
  if (!html)
    return { type: 'script', refsMap: {}, refs: [] }
  const result = jsxDfs([html], null, position, code)
  const map = {
    refsMap: {},
    refs: [],
  }

  if (result)
    return Object.assign(result, map)

  return {
    type: 'script',
    ...map,
  }
}

// let stop: any = null
// export const alias = getConfiguration('common-intellisense.alias') as Record<string, string>
// export async function findPkgUI(cwd?: string) {
//   if (!cwd)
//     return
//   const pkg = await findUp('package.json', { cwd })
//   if (!pkg)
//     return
//   if (stop)
//     stop()
//   stop = watchFiles(pkg, {
//     onChange() {
//       urlCache.clear()
//       findUI()
//     },
//   })
//   const p = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
//   const { dependencies, devDependencies } = p
//   const result = []
//   const aliasUiNames = Object.keys(alias)
//   if (dependencies) {
//     for (const key in dependencies) {
//       if (UINames.includes(key) || aliasUiNames.includes(key))
//         result.push([key, dependencies[key]])
//     }
//   }
//   if (devDependencies) {
//     for (const key in devDependencies) {
//       if (UINames.includes(key) || aliasUiNames.includes(key))
//         result.push([key, devDependencies[key]])
//     }
//   }
//   return { pkg, uis: result }
// }

export function transformTagName(name: string) {
  return name[0].toUpperCase() + name.replace(/(-\w)/g, (match: string) => match[1].toUpperCase()).slice(1)
}

export function isInAttribute(child: any, position: any, offset: number, cursorOffset?: number) {
  const len = child.props.length
  let end = null
  const start = {
    column: child.loc.start.column + child.tag.length + 1,
    line: child.loc.start.line,
    offset: child.loc.start.offset + child.tag.length + 1,
  }
  if (!len) {
    const childNode = child.children?.[0]
    if (childNode) {
      end = {
        line: childNode.loc.start.line,
        column: childNode.loc.start.column - 1,
        offset: childNode.loc.start.offset - 1,
      }
    }
    else {
      if (child.isSelfClosing) {
        end = {
          line: child.loc.end.line,
          column: child.loc.end.column - 2,
          offset: child.loc.end.offset - 2,
        }
      }
      else {
        const startOffset = start.offset
        const tail = child.loc.source.slice(child.tag.length + 1)
        const match = tail.match('>')
        const endOffset = match?.index !== undefined
          ? startOffset + match.index
          : child.loc.end?.offset ?? (startOffset + tail.length)
        if (cursorOffset === undefined)
          return isInPosition({ start, end: { line: child.loc.end.line, column: child.loc.end.column, offset: endOffset } }, position, offset)
        return (startOffset + offset < cursorOffset) && (cursorOffset <= endOffset + offset)
      }
    }
  }
  else {
    const offsetX = child.props[len - 1].loc.end.offset - child.loc.start.offset
    const tail = child.loc.source.slice(offsetX)
    const xMatch = tail.match('>')
    const x = xMatch?.index ?? tail.length
    end = {
      column: child.props[len - 1].loc.end.column + 1 + x,
      line: child.props[len - 1].loc.end.line,
      offset: child.props[len - 1].loc.end.offset + 1 + x,
    }
  }

  if (cursorOffset === undefined)
    return isInPosition({ start, end }, position, offset)
  const startOffset = start.offset
  const endOffset = end.offset
  return (startOffset + offset < cursorOffset) && (cursorOffset <= endOffset + offset)
}

export function convertPositionToLoc(data: any, code: string) {
  const { start, end } = data
  return {
    start: convertCodeOffsetToLineColumn(code, start),
    end: convertCodeOffsetToLineColumn(code, end),
  }
}

function getLineStarts(code: string) {
  if (lineIndexCache?.code === code)
    return lineIndexCache.starts
  const starts = [0]
  for (let index = 0; index < code.length; index++) {
    if (code.charCodeAt(index) === 10)
      starts.push(index + 1)
  }
  lineIndexCache = { code, starts }
  return starts
}

function getSourceOffset(code: string, position: vscode.Position) {
  const starts = getLineStarts(code)
  const lineStart = starts[Math.max(0, Math.min(position.line, starts.length - 1))] || 0
  return Math.min(lineStart + position.character, code.length)
}

function getSourcePosition(code: string, offset: number): vscode.Position {
  const loc = convertCodeOffsetToLineColumn(code, offset)
  return { line: loc.line - 1, character: loc.column - 1 } as vscode.Position
}

function convertCodeOffsetToLineColumn(code: string, offset: number) {
  const starts = getLineStarts(code)
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (starts[middle] <= offset)
      low = middle + 1
    else
      high = middle
  }
  const lineIndex = Math.max(0, low - 1)
  const lineStart = starts[lineIndex]
  const lineEnd = code.indexOf('\n', lineStart)
  return {
    line: lineIndex + 1,
    column: offset - lineStart + 1,
    lineText: code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd),
    lineOffset: offset,
  }
}

export interface SlotAnalysisIdentity {
  packagePath: string
  contextGeneration: number
  contextRevision: number
}

export interface SlotAnalysisRequest extends SlotAnalysisIdentity {
  uri: string
  documentVersion: number
  requestId: number
  epoch: number
}

export interface SlotAnalysis extends SlotAnalysisRequest {
  children: any[]
}

const MAX_DOCUMENT_SLOT_ANALYSES = 20
const documentSlotAnalyses = new Map<string, SlotAnalysis>()
const latestSlotRequests = new Map<string, SlotAnalysisRequest>()
let slotRequestSequence = 0
let slotAnalysisEpoch = 0
const codeLensEmitter = new vscode.EventEmitter<void>()

export function refreshCodeLenses() {
  codeLensEmitter.fire()
}

export function clearDocumentAnalysesForPackages(packagePaths: string[]) {
  if (!packagePaths.length) {
    clearDocumentAnalysis()
    return
  }
  const affected = new Set(packagePaths)
  let deleted = false
  for (const [uri, analysis] of documentSlotAnalyses) {
    if (!affected.has(analysis.packagePath))
      continue
    documentSlotAnalyses.delete(uri)
    latestSlotRequests.delete(uri)
    deleted = true
  }
  for (const [uri, request] of latestSlotRequests) {
    if (affected.has(request.packagePath))
      latestSlotRequests.delete(uri)
  }
  if (deleted)
    refreshCodeLenses()
}

function cancelDocumentSlotAnalysis(request: SlotAnalysisRequest) {
  if (latestSlotRequests.get(request.uri)?.requestId === request.requestId)
    latestSlotRequests.delete(request.uri)
  if (documentSlotAnalyses.get(request.uri)?.requestId === request.requestId) {
    documentSlotAnalyses.delete(request.uri)
    refreshCodeLenses()
  }
}

export function clearDocumentAnalysis(uri?: string | vscode.Uri) {
  if (uri) {
    const key = typeof uri === 'string' ? uri : uri.toString()
    latestSlotRequests.delete(key)
    const deleted = documentSlotAnalyses.delete(key)
    if (deleted)
      refreshCodeLenses()
    return
  }
  slotAnalysisEpoch++
  latestSlotRequests.clear()
  if (documentSlotAnalyses.size) {
    documentSlotAnalyses.clear()
    refreshCodeLenses()
  }
}

export function getDocumentSlotAnalysis(uri: string | vscode.Uri) {
  const key = typeof uri === 'string' ? uri : uri.toString()
  const analysis = documentSlotAnalyses.get(key)
  if (analysis) {
    documentSlotAnalyses.delete(key)
    documentSlotAnalyses.set(key, analysis)
  }
  return analysis
}

function isOlderSlotContext(candidate: SlotAnalysisRequest, current: SlotAnalysisRequest) {
  if (candidate.uri !== current.uri || candidate.packagePath !== current.packagePath)
    return false
  if (candidate.documentVersion !== current.documentVersion)
    return candidate.documentVersion < current.documentVersion
  return candidate.contextGeneration < current.contextGeneration
    || (candidate.contextGeneration === current.contextGeneration && candidate.contextRevision < current.contextRevision)
}

export function beginDocumentSlotAnalysis(uri: string | vscode.Uri, documentVersion: number, identity: SlotAnalysisIdentity): SlotAnalysisRequest {
  const key = typeof uri === 'string' ? uri : uri.toString()
  const request: SlotAnalysisRequest = { uri: key, documentVersion, requestId: ++slotRequestSequence, epoch: slotAnalysisEpoch, ...identity }
  const latest = latestSlotRequests.get(key)
  const committed = documentSlotAnalyses.get(key)
  if ((!latest || !isOlderSlotContext(request, latest)) && (!committed || !isOlderSlotContext(request, committed)))
    latestSlotRequests.set(key, request)
  return request
}

export function commitDocumentSlotAnalysis(request: SlotAnalysisRequest, children: any[]) {
  const latest = latestSlotRequests.get(request.uri)
  const committed = documentSlotAnalyses.get(request.uri)
  if (request.epoch !== slotAnalysisEpoch || latest?.requestId !== request.requestId || (committed && isOlderSlotContext(request, committed)))
    return false
  const analysis: SlotAnalysis = { ...request, children }
  documentSlotAnalyses.delete(request.uri)
  documentSlotAnalyses.set(request.uri, analysis)
  while (documentSlotAnalyses.size > MAX_DOCUMENT_SLOT_ANALYSES) {
    const oldest = documentSlotAnalyses.keys().next().value!
    const evicted = documentSlotAnalyses.get(oldest)
    documentSlotAnalyses.delete(oldest)
    const latestRequest = latestSlotRequests.get(oldest)
    if (latestRequest?.requestId === evicted?.requestId)
      latestSlotRequests.delete(oldest)
  }
  refreshCodeLenses()
  return true
}

export interface SlotSourceContext {
  cacheMap: Map<string, any>
  sourceScopes: Map<string, ComponentSourceScope>
  localDeps?: Record<string, string>
  currentDocumentPath?: string
  workspaceRoot?: string
}

export async function detectSlots(document: vscode.TextDocument, UiCompletions: any, uiDeps: any, prefix: string[], identity?: SlotAnalysisIdentity, sourceContext?: SlotSourceContext): Promise<void>
export async function detectSlots(UiCompletions: any, uiDeps: any, prefix: string[]): Promise<void>
export async function detectSlots(documentOrCompletions: vscode.TextDocument | any, completionsOrDeps: any, depsOrPrefix: any, maybePrefix?: string[], maybeIdentity?: SlotAnalysisIdentity, maybeSourceContext?: SlotSourceContext) {
  const hasDocument = documentOrCompletions?.uri && typeof documentOrCompletions.getText === 'function'
  const document = hasDocument ? documentOrCompletions as vscode.TextDocument : getActiveTextEditor()?.document
  if (!document || document.isClosed)
    return
  const isVineDocument = document.uri.toString().endsWith('.vine.ts')
  if (document.languageId !== 'vue' && !isVineDocument)
    return
  const UiCompletions = hasDocument ? completionsOrDeps : documentOrCompletions
  const uiDeps = hasDocument ? depsOrPrefix : completionsOrDeps
  const prefix = (hasDocument ? maybePrefix : depsOrPrefix) || []
  const identity = hasDocument ? maybeIdentity : undefined
  const sourceContext = hasDocument ? maybeSourceContext : undefined
  const request = beginDocumentSlotAnalysis(document.uri, document.version, identity || { packagePath: '', contextGeneration: 0, contextRevision: 0 })
  const children = (await getTemplateAst(document, UiCompletions, uiDeps, prefix, sourceContext)).filter(item => item.children.length)

  if (document.isClosed || document.version !== request.documentVersion) {
    cancelDocumentSlotAnalysis(request)
    return
  }
  commitDocumentSlotAnalysis(request, children)
}

export function registerCodeLensProviderFn() {
  const isZh = getLocale().includes('zh')
  // Slot edits currently emit Vue/Vine template syntax. Keep the TypeScript
  // selector only for `.vine.ts`; React requires framework-specific edits.
  return registerCodeLensProvider(['vue', 'typescript'], {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(document: vscode.TextDocument) {
      const languageId = document.languageId
      const isVineDocument = document.uri.toString().endsWith('.vine.ts')
      if (languageId !== 'vue' && !isVineDocument)
        return []
      const result: vscode.CodeLens[] = []
      const analysis = getDocumentSlotAnalysis(document.uri)
      if (!analysis || analysis.documentVersion !== document.version)
        return result
      const children = analysis.children
      let documentCode: string | undefined
      const positionAt = (offset: number) => typeof document.positionAt === 'function'
        ? document.positionAt(offset)
        : getPosition(offset, documentCode ??= document.getText()).position
      children.forEach((child: any) => {
        const offset = child.offset
        child.children.forEach((m: any) => {
          const { child, slots } = m
          const range = child.loc
          const filters: string[] = []
          for (const c of Array.from(child.children) as any) {
            if (c.type === 'JSXElement') {
              for (const p of c.openingElement?.attributes || []) {
                const namespace = p.name?.namespace?.name
                if (namespace === 'v-slot') {
                  const slotName = p.name?.name?.name
                  if (slotName)
                    filters.push(slotName)
                  break
                }
              }
            }
            else if (c.tag && c.props) {
              for (const p of c.props) {
                if (p.name === 'slot') {
                  const slotName = p.arg?.content || p.value?.content
                  if (slotName)
                    filters.push(slotName)
                  break
                }
              }
            }
            else if (c.codegenNode?.tag && c.codegenNode.props) {
              for (const p of c.codegenNode.props) {
                if (p.name === 'slot') {
                  const slotName = p.arg?.content || p.value?.content
                  if (slotName)
                    filters.push(slotName)
                  break
                }
              }
            }
          }
          slots.filter((s: any) => !filters.includes(s.name)).forEach((s: any, i: number) => {
            const { name, description, description_zh, version } = s
            // Normalize compiler AST and ESTree nodes into absolute document offsets.
            const absoluteRange = getNodeOffsetRange(child, offset)
            const codeLensRange = absoluteRange
              ? new vscode.Range(positionAt(absoluteRange.start), positionAt(absoluteRange.end))
              : createRange(range.start.line - 1, range.start.column, range.end.line - 1, range.end.column)

            result.push(new vscode.CodeLens(codeLensRange, {
              title: `${i === 0 ? 'Slots: ' : ''}${name}`,
              tooltip: (version ? `❗${version} VERSION: ` : '') + (isZh ? description_zh : description),
              command: 'common-intellisense.slots',
              arguments: [child, name, offset, s, {
                uri: document.uri.toString(),
                version: document.version,
                packagePath: analysis.packagePath,
                contextGeneration: analysis.contextGeneration,
                contextRevision: analysis.contextRevision,
              }],
            }))
          })
        })
      })
      return result
    },
  })
}

async function getTemplateAst(document: vscode.TextDocument, UiCompletions: any, uiDeps: any, prefix: string[], sourceContext?: SlotSourceContext): Promise<Array<{ children: any, offset: number }>> {
  const code = document.getText()
  const uri = document.uri.toString()
  const isVueDocument = document.languageId === 'vue' || uri.endsWith('.vue')
  const isVineDocument = uri.endsWith('.vine.ts')

  if (isVueDocument) {
    const {
      descriptor: { template, script, scriptSetup },
    } = getVueSfcParseResult(code)
    const analyses: Array<{ children: any, offset: number }> = []
    if (template) {
      analyses.push({
        children: await findUiTag(template.ast.children, UiCompletions, [], new Set(), uiDeps, prefix, sourceContext),
        offset: 0,
      })
    }
    else {
      for (const block of [script, scriptSetup]) {
        const lang = block?.lang?.toLowerCase()
        if (!block || (lang !== 'tsx' && lang !== 'jsx'))
          continue
        const jsxElements: any[] = []
        collectJsxElements(getJsxAst(block.content), jsxElements)
        analyses.push({
          children: await findUiTag(jsxElements, UiCompletions, [], new Set(), uiDeps, prefix, sourceContext),
          offset: block.loc.start.offset,
        })
      }
    }
    return analyses
  }
  else if (isVineDocument) {
    const { vineFileCtx } = createVineFileCtx('', code)
    if (!vineFileCtx.vineCompFns)
      return []

    return await Promise.all(vineFileCtx.vineCompFns.map(async (item: any) => {
      const r = {
        children: await findUiTag(item.templateAst?.children, UiCompletions, [], new Set(), uiDeps, prefix, sourceContext),
        offset: item.templateStringNode?.quasi.quasis[0].start || 0,
      }
      return r
    })) as any
  }
  return []
}
export async function findUiTag(children: any, UiCompletions: any, result: any[] = [], cacheMap = new Set(), uiDeps: any = {}, prefix: string[] = [], sourceContext?: SlotSourceContext) {
  for (const child of children || []) {
    let tag: string | undefined = child.tag
    if (child.type === 'JSXElement')
      tag = getJsxElementName(child.openingElement?.name)

    if (!tag)
      continue
    const nextChildren = child.children
    if (nextChildren?.length)
      await findUiTag(nextChildren, UiCompletions, result, cacheMap, uiDeps, prefix, sourceContext)

    const range = child.range ?? child.loc
    if (cacheMap.has(range))
      continue

    const importedTag = resolveImportedTag(tag, uiDeps)
    const source = importedTag.source || sourceContext?.localDeps?.[importedTag.localRoot]
    if (!source && isNativeTag(tag))
      continue
    const localSource = isLocalModuleSource(source)
    let scopedCompletions = UiCompletions
    let normalizedSource = source
    if (source && sourceContext && !localSource) {
      const scope = getSourceScope(sourceContext, source)
      if (scope) {
        const scoped = sourceContext.cacheMap.get(scope.key)
        if (scoped && typeof scoped === 'object' && !Array.isArray(scoped))
          scopedCompletions = scoped
        normalizedSource = scope.exactLib || scope.lib
      }
    }

    let target: any
    if (localSource) {
      target = await resolveLocalWrappedComponent(source!, UiCompletions, prefix, sourceContext?.currentDocumentPath, sourceContext?.workspaceRoot, (wrappedSource) => {
        const scope = sourceContext ? getSourceScope(sourceContext, wrappedSource) : undefined
        const scoped = scope ? sourceContext?.cacheMap.get(scope.key) : undefined
        return scoped && typeof scoped === 'object' && !Array.isArray(scoped) ? scoped : undefined
      })
    }
    else {
      for (const candidate of importedTag.candidates) {
        target = source
          ? await findDynamicComponent(candidate, {}, scopedCompletions, prefix, normalizedSource)
          : findPrefixedComponent(candidate, prefix.filter(Boolean), scopedCompletions)
            || scopedCompletions[candidate]
            || await findDynamicComponent(candidate, {}, scopedCompletions, prefix)
        const scope = source && sourceContext ? getSourceScope(sourceContext, source) : undefined
        if (target && sourceScopeAccepts(scope, target.lib))
          break
        target = undefined
      }
    }

    // An explicit import source is authoritative. Never fall back to a same-name
    // component from the flattened map when its scoped candidate is absent.
    if (!target?.rawSlots?.length)
      continue
    cacheMap.add(range)
    result.push({ child, slots: target.rawSlots })
  }
  return result
}

export function parserVine(code: string, position: vscode.Position, cursorOffset = getSourceOffset(code, position)) {
  const { vineFileCtx } = createVineFileCtx('', code)
  if (!vineFileCtx.vineCompFns.length)
    return

  return transformVine(vineFileCtx, position, cursorOffset)
}

export function createVineFileCtx(sourceFileName: string, source: string): VineFileCtxResult {
  const key = `${sourceFileName}\0${source}`
  if (vineCtxCache.has(key)) {
    const cached = vineCtxCache.get(key)!
    vineCtxCache.delete(key)
    vineCtxCache.set(key, cached)
    return cached
  }

  const compilerCtx = createCompilerCtx({
    envMode: 'module',
    vueCompilerOptions: {
      // 'module' will break Volar virtual code's mapping
      mode: 'function',
      // These options below is for resolving conflicts
      // with original compiler's mode: 'module'
      cacheHandlers: false,
      prefixIdentifiers: false,
      scopeId: null,
    },
    inlineTemplate: false,
  })
  const vineCompileErrs: VineDiagnostic[] = []
  const vineCompileWarns: VineDiagnostic[] = []
  const compilerHooks: VineCompilerHooks = {
    onError: err => vineCompileErrs.push(err),
    onWarn: warn => vineCompileWarns.push(warn),
    getCompilerCtx: () => compilerCtx,
  }
  const vineFileCtx = compileVineTypeScriptFile(
    source,
    sourceFileName,
    {
      compilerHooks,
      babelParseOptions: {
        tokens: true,
      },
    },
  )

  const value = {
    vineFileCtx,
    vineCompileErrs,
    vineCompileWarns,
  }
  vineCtxCache.set(key, value)
  while (vineCtxCache.size > parserCacheLimit)
    vineCtxCache.delete(vineCtxCache.keys().next().value!)
  return value
}

export function isSamePrefix(label: string, key: string) {
  let labelName = label.split('=')[0]
  if (labelName.indexOf(' ')) {
    // 防止匹配到描述中的=
    labelName = labelName.split(' ')[0]
  }
  return labelName === key
}

const IMPORT_VUE_REG = /import\s+(\S+)\s+from\s+['"]([^"']+.vue)['"]/g

function getBabelPluginsForVueBlock(lang?: string) {
  switch (lang?.toLowerCase()) {
    case 'tsx':
      return ['typescript', 'jsx'] as any[]
    case 'jsx':
      return ['jsx'] as any[]
    case 'js':
    case 'javascript':
      return [] as any[]
    default:
      return ['typescript'] as any[]
  }
}

function findDynamicImportSource(node: any): string | null {
  if (!node)
    return null
  if (node.type === 'CallExpression' && node.callee?.type === 'Import')
    return node.arguments?.[0]?.value || null
  if (node.type === 'ImportExpression' || node.type === 'Import')
    return node.source?.value || node.arguments?.[0]?.value || null
  if (node.type === 'MemberExpression')
    return findDynamicImportSource(node.object)
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')
    return findDynamicImportSource(node.body)
  if (node.type === 'BlockStatement') {
    const returned = node.body.find((entry: any) => entry.type === 'ReturnStatement')
    return findDynamicImportSource(returned?.argument)
  }
  return null
}

function parseImportDepsBlock(content: string, lang?: string) {
  const deps: Record<string, string> = {}
  if (!content.trim())
    return deps
  try {
    const ast = babelParse(content, {
      sourceType: 'module',
      plugins: getBabelPluginsForVueBlock(lang),
    })
    traverse(ast as any, {
      ImportDeclaration(p: any) {
        const source = p.node.source.value
        if (!/^[./@]/.test(source))
          return
        for (const specifier of p.node.specifiers || [])
          deps[specifier.local.name] = source
      },
      VariableDeclarator(p: any) {
        const id = p.node.id
        const init = p.node.init
        if (!id?.name || !init)
          return
        const source = init.type === 'CallExpression' && init.callee?.name === 'defineAsyncComponent'
          ? findDynamicImportSource(init.arguments?.[0])
          : findDynamicImportSource(init)
        if (source)
          deps[id.name] = source
      },
      ExportDefaultDeclaration(p: any) {
        const declaration = p.node.declaration
        if (declaration?.type !== 'ObjectExpression')
          return
        for (const property of declaration.properties || []) {
          if (property.type !== 'ObjectProperty' || (property.key?.name || property.key?.value) !== 'components' || property.value?.type !== 'ObjectExpression')
            continue
          for (const entry of property.value.properties || []) {
            if (entry.type !== 'ObjectProperty')
              continue
            const localName = entry.key?.name || entry.key?.value
            if (!localName)
              continue
            if (entry.value?.type === 'Identifier')
              deps[localName] = deps[entry.value.name] || entry.value.name
            else
              deps[localName] = localName
          }
        }
      },
    })
  }
  catch {
    // Recover simple local default imports per block without combining scopes.
    const clean = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    for (const match of clean.matchAll(IMPORT_VUE_REG))
      deps[match[1]] = match[2]
  }
  return deps
}

export function getImportDeps(text: string, context: { activeOffset?: number } = {}) {
  const { descriptor: { script, scriptSetup } } = getVueSfcParseResult(text)
  const blocks = [script, scriptSetup].filter((block): block is NonNullable<typeof block> => !!block)
  if (!blocks.length)
    return parseImportDepsBlock(text, 'tsx')

  if (typeof context.activeOffset === 'number') {
    const active = blocks.find(block => context.activeOffset! >= block.loc.start.offset && context.activeOffset! <= block.loc.end.offset)
    return active ? parseImportDepsBlock(active.content, active.lang) : {}
  }

  // Template scope sees both blocks. Apply normal script first so script-setup
  // bindings deterministically win when the same local name exists in both.
  return Object.assign(
    {},
    script ? parseImportDepsBlock(script.content, script.lang) : {},
    scriptSetup ? parseImportDepsBlock(scriptSetup.content, scriptSetup.lang) : {},
  )
}

export function getAbsoluteUrl(url: string, currentFileUrl?: string, workspaceRoot?: string) {
  const base = currentFileUrl || getCurrentFileUrl()
  if (!base)
    return
  const clean = url.replace(/[?#].*$/, '')
  if (clean.startsWith('file:')) {
    try { return fileURLToPath(clean) }
    catch { return }
  }
  if (clean.startsWith('@/') || clean.startsWith('~/')) {
    const root = workspaceRoot || (!currentFileUrl ? getRootPath() : undefined)
    return root ? path.resolve(root, clean.slice(2)) : undefined
  }
  return path.isAbsolute(clean) ? clean : path.resolve(base, '..', clean)
}

const localComponentExtensions = ['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte']
const maxLocalComponentSize = 4 * 1024 * 1024
const maxLocalComponentCacheEntries = 20
interface WrapperImport { localName: string, importedName: string, source: string }
interface LocalWrapperTarget { localTag: string, lookupTag: string, source?: string }
const localComponentTagCache = new Map<string, { signature: string, target?: LocalWrapperTarget }>()

function isSameOrWithinPath(target: string, root: string) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function touchLocalComponentCache(key: string, value: { signature: string, target?: LocalWrapperTarget }) {
  localComponentTagCache.delete(key)
  localComponentTagCache.set(key, value)
  while (localComponentTagCache.size > maxLocalComponentCacheEntries)
    localComponentTagCache.delete(localComponentTagCache.keys().next().value!)
}

export function clearLocalComponentCache() {
  localComponentTagCache.clear()
}

async function findProjectResolutionContext(currentFile: string, workspaceRoot: string) {
  const root = path.resolve(workspaceRoot)
  let directory = path.dirname(path.resolve(currentFile))
  let projectRoot: string | undefined
  while (isSameOrWithinPath(directory, root)) {
    for (const configName of ['tsconfig.json', 'jsconfig.json']) {
      const configPath = path.join(directory, configName)
      try {
        if ((await fsp.stat(configPath)).isFile())
          return { projectRoot: projectRoot || directory, configPath }
      }
      catch {}
    }
    if (!projectRoot) {
      try {
        if ((await fsp.stat(path.join(directory, 'package.json'))).isFile())
          projectRoot = directory
      }
      catch {}
    }
    if (directory === root)
      break
    const parent = path.dirname(directory)
    if (parent === directory)
      break
    directory = parent
  }
  return { projectRoot: projectRoot || root, configPath: undefined }
}

async function resolveProjectAliasBase(source: string, currentFile: string, workspaceRoot: string) {
  const { projectRoot, configPath } = await findProjectResolutionContext(currentFile, workspaceRoot)
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath))
      const resolved = ts.resolveModuleName(source, currentFile, parsed.options, ts.sys).resolvedModule?.resolvedFileName
      if (resolved && isSameOrWithinPath(path.resolve(resolved), path.resolve(workspaceRoot)))
        return resolved.replace(/\.d\.[cm]?ts$/, '')
      const paths = parsed.options.paths || {}
      const baseUrl = parsed.options.baseUrl || path.dirname(configPath)
      for (const [pattern, replacements] of Object.entries(paths)) {
        const star = pattern.indexOf('*')
        const matches = star < 0
          ? pattern === source ? [''] : undefined
          : source.startsWith(pattern.slice(0, star)) && source.endsWith(pattern.slice(star + 1))
            ? [source.slice(star, source.length - (pattern.length - star - 1))]
            : undefined
        if (!matches)
          continue
        for (const replacement of replacements) {
          const candidate = path.resolve(baseUrl, replacement.replace('*', matches[0]))
          if (isSameOrWithinPath(candidate, path.resolve(workspaceRoot)))
            return candidate
        }
      }
    }
  }
  if (source.startsWith('~/'))
    return path.resolve(projectRoot, source.slice(2))
  if (source.startsWith('/src/'))
    return path.resolve(projectRoot, source.slice(1))
}

export async function resolveLocalComponentModule(url: string, currentFileUrl?: string, workspaceRoot?: string) {
  // Provider paths always pass workspaceRoot. Legacy calls are limited to the
  // current document directory rather than being allowed to read arbitrary files.
  const effectiveCurrentFile = currentFileUrl || getCurrentFileUrl()
  const allowedRoot = workspaceRoot || (effectiveCurrentFile ? path.dirname(effectiveCurrentFile) : undefined)
  if (!allowedRoot || !effectiveCurrentFile)
    return
  const clean = url.replace(/[?#].*$/, '')
  let base = workspaceRoot ? await resolveProjectAliasBase(clean, effectiveCurrentFile, workspaceRoot) : undefined
  if (!base)
    base = getAbsoluteUrl(clean, effectiveCurrentFile, workspaceRoot)
  if (!base)
    return
  const lexicalRoot = path.resolve(allowedRoot)
  if (!isSameOrWithinPath(path.resolve(base), lexicalRoot))
    return
  let realRoot: string
  try { realRoot = await fsp.realpath(lexicalRoot) }
  catch { return }

  const candidates = [base]
  if (!path.extname(base)) {
    candidates.push(...localComponentExtensions.map(extension => `${base}${extension}`))
    candidates.push(...localComponentExtensions.map(extension => path.join(base, `index${extension}`)))
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const realCandidate = await fsp.realpath(candidate)
      if (!isSameOrWithinPath(realCandidate, realRoot))
        continue
      const stat = await fsp.stat(realCandidate)
      if (stat.isFile() && stat.size <= maxLocalComponentSize)
        return realCandidate
    }
    catch {}
  }
}

export async function resolveLocalWrappedComponent(source: string, UiCompletions: PropsConfig, prefix: string[], currentFileUrl?: string, workspaceRoot?: string, selectSource?: (source: string) => PropsConfig | undefined) {
  const absoluteUrl = await resolveLocalComponentModule(source, currentFileUrl, workspaceRoot)
  if (!absoluteUrl)
    return
  try {
    const target = await getTemplateParentElementName(absoluteUrl)
    if (!target)
      return
    if (target.source) {
      const scoped = selectSource?.(target.source)
      // An explicit wrapper import is authoritative. If its source is unknown,
      // never guess from the flattened completion table.
      if (!scoped)
        return
      return findDynamic(target.lookupTag, scoped, prefix)
    }
    return findDynamic(target.lookupTag, UiCompletions, prefix)
  }
  catch {}
}

export async function findDynamicComponent(name: string, deps: Record<string, string>, UiCompletions: PropsConfig, prefix: string[], from?: string, currentFileUrl?: string, preferDependency = false, workspaceRoot?: string) {
  const dep = deps[name]
  if (preferDependency && dep) {
    const absoluteUrl = await resolveLocalComponentModule(dep, currentFileUrl, workspaceRoot)
    if (!absoluteUrl)
      return
    try {
      const target = await getTemplateParentElementName(absoluteUrl)
      return target ? findDynamic(target.lookupTag, UiCompletions, prefix, target.source || from) : undefined
    }
    catch {
      // An explicit local import is authoritative. A missing/incomplete wrapper
      // must not silently resolve to a flattened component with the same name.
      return
    }
  }

  let target = findDynamic(name, UiCompletions, prefix, from)
  if (target)
    return target

  if (dep) {
    // 只往下找一层
    const absoluteUrl = await resolveLocalComponentModule(dep, currentFileUrl, workspaceRoot)
    if (!absoluteUrl)
      return
    const wrapped = await getTemplateParentElementName(absoluteUrl)
    if (!wrapped)
      return
    target = findDynamic(wrapped.lookupTag, UiCompletions, prefix, wrapped.source || from)
  }
  return target
}

function findDynamic(tag: string, UiCompletions: PropsConfig, prefix: string[], from?: string) {
  if (!UiCompletions)
    return

  const normalizedFrom = from ? (nameMap[from] || from) : undefined
  const acceptsSource = (candidate: PropsConfigItem | undefined | null) => !!candidate && (!normalizedFrom || (nameMap[candidate.lib] || candidate.lib) === normalizedFrom)
  const direct = UiCompletions[tag]
  const hyphenated = UiCompletions[hyphenate(tag[0].toLocaleLowerCase() + tag.slice(1))]
  let target: PropsConfigItem | null = acceptsSource(direct) ? direct : acceptsSource(hyphenated) ? hyphenated : null

  if (!target) {
    for (const p of prefix) {
      if (!p)
        continue

      // Try prefix + PascalCase: P + Button = PButton
      const prefixedPascalCase = p[0].toUpperCase() + p.slice(1) + tag
      const t1 = UiCompletions[prefixedPascalCase]
      if (acceptsSource(t1)) {
        target = t1
        break
      }

      // Try prefix + kebab-case component: if tag is "button", try p + "button" = "p-button"
      // Then convert "p-button" to PascalCase "PButton" for lookup
      if (tag.toLowerCase() === tag) { // if tag is lowercase like "button"
        const kebabWithPrefix = `${p}-${tag}`
        const standardName = convertPrefixedComponentName(kebabWithPrefix, p)
        if (standardName) {
          const t2 = UiCompletions[standardName]
          if (acceptsSource(t2)) {
            target = t2
            break
          }
        }
      }
    }
  }
  // Final fallback: try suffix-based matching on completion keys. This lets
  // tags like "Pagination" match keys such as "ElPagination" when prefix
  // lookup didn't find a direct match.
  if (!target && UiCompletions) {
    const want = tag.toLowerCase()
    let bestKey: string | null = null
    for (const key of Object.keys(UiCompletions)) {
      const k = key.toLowerCase()
      if (!k.endsWith(want))
        continue
      // prefer matches with same lib when `from` specified
      const candidate = UiCompletions[key]
      if (!acceptsSource(candidate))
        continue
      if (normalizedFrom) {
        target = candidate
        break
      }
      if (!bestKey || key.length > bestKey.length)
        bestKey = key
    }
    if (!target && bestKey)
      target = UiCompletions[bestKey]
  }
  return target
}

function createWrapperImportIndex(code: string): Map<string, WrapperImport> {
  const imports = new Map<string, WrapperImport>()
  if (!code.trim())
    return imports
  try {
    const ast = babelParse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] }) as any
    for (const node of ast.program?.body || []) {
      if (node.type !== 'ImportDeclaration' || typeof node.source?.value !== 'string')
        continue
      for (const specifier of node.specifiers || []) {
        const localName = specifier.local?.name
        if (!localName)
          continue
        const importedName = specifier.type === 'ImportSpecifier'
          ? (specifier.imported?.name || specifier.imported?.value)
          : specifier.type === 'ImportNamespaceSpecifier' ? '*' : 'default'
        imports.set(localName, { localName, importedName: String(importedName), source: node.source.value })
      }
    }
  }
  catch {}
  return imports
}

function resolveWrapperTarget(localTag: string | undefined, imports: Map<string, WrapperImport>): LocalWrapperTarget | undefined {
  if (!localTag)
    return
  const [root, ...members] = localTag.split('.')
  const imported = imports.get(root)
  if (!imported)
    return { localTag, lookupTag: localTag }
  const importedRoot = imported.importedName === '*'
    ? (members.shift() || root)
    : imported.importedName === 'default' ? root : imported.importedName
  return {
    localTag,
    lookupTag: [importedRoot, ...members].filter(Boolean).join('.'),
    source: imported.source,
  }
}

async function getTemplateParentElementName(url: string) {
  const realUrl = await fsp.realpath(url)
  const stat = await fsp.stat(realUrl)
  if (!stat.isFile() || stat.size > maxLocalComponentSize)
    return
  const signature = `${stat.mtimeMs}:${stat.size}`
  const cached = localComponentTagCache.get(realUrl)
  if (cached?.signature === signature) {
    touchLocalComponentCache(realUrl, cached)
    return cached.target
  }
  const code = await fsp.readFile(realUrl, 'utf-8')
  const extension = path.extname(realUrl).toLowerCase()
  const cache = (target?: LocalWrapperTarget) => {
    touchLocalComponentCache(realUrl, { signature, target })
    return target
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const plugins: any[] = extension === '.ts' || extension === '.tsx' ? ['typescript', 'jsx'] : ['jsx']
    const ast = babelParse(code, { sourceType: 'module', plugins }) as any
    const programBody = ast.program?.body || []
    const defaultExport = programBody.find((node: any) => node.type === 'ExportDefaultDeclaration')?.declaration

    const resolveIdentifier = (name: string) => {
      for (const node of programBody) {
        if (node.type === 'FunctionDeclaration' && node.id?.name === name)
          return node
        if (node.type !== 'VariableDeclaration')
          continue
        const declaration = node.declarations?.find((item: any) => item.id?.type === 'Identifier' && item.id.name === name)
        if (declaration)
          return declaration.init
      }
    }
    const collectReturnedJsx = (node: any, results: any[]): void => {
      if (!node)
        return
      if (node.type === 'JSXElement') {
        results.push(node)
        return
      }
      if (node.type === 'Identifier') {
        collectReturnedJsx(resolveIdentifier(node.name), results)
        return
      }
      if (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) {
        collectReturnedJsx(node.expression, results)
        return
      }
      if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') {
        collectReturnedJsx(node.body, results)
        return
      }
      if (node.type === 'ReturnStatement') {
        collectReturnedJsx(node.argument, results)
        return
      }
      if (node.type === 'ConditionalExpression') {
        collectReturnedJsx(node.consequent, results)
        collectReturnedJsx(node.alternate, results)
        return
      }
      if (node.type === 'BlockStatement') {
        for (const statement of node.body || []) {
          // Nested declarations are not part of the default component's render path.
          if (statement.type === 'FunctionDeclaration')
            continue
          collectReturnedJsx(statement, results)
        }
        return
      }
      if (node.type === 'IfStatement') {
        collectReturnedJsx(node.consequent, results)
        collectReturnedJsx(node.alternate, results)
      }
    }

    const roots: any[] = []
    collectReturnedJsx(defaultExport, roots)
    const tag = roots.length === 1 ? getJsxElementName(roots[0].openingElement?.name) : undefined
    return cache(resolveWrapperTarget(tag, createWrapperImportIndex(code)))
  }
  if (extension === '.svelte') {
    const html = getSvelteHtml(code)
    const elements = (html?.children || []).filter((child: any) => child?.name)
    const tag = elements.length === 1 ? elements[0].name : undefined
    const instanceCode = getSvelteInstanceScript(code)?.content || ''
    return cache(resolveWrapperTarget(tag, createWrapperImportIndex(instanceCode)))
  }

  // 如果有defineProps或者props的忽律，交给v-component-prompter处理
  const {
    descriptor: { template, script, scriptSetup },
  } = getVueSfcParseResult(code)

  if (script?.content && /^\s*props:\s*\{/.test(script.content))
    return cache()
  if (scriptSetup?.content && /defineProps\(/.test(scriptSetup.content))
    return cache()
  if (!template?.ast?.children?.length)
    return cache()

  let result = ''
  for (const child of template.ast.children) {
    const node = child as any
    if (node.tag) {
      if (result) // 说明template下不是唯一父节点
        return cache()
      result = node.tag
    }
  }
  const tag = result || undefined
  const wrapperImports = createWrapperImportIndex(`${script?.content || ''}\n${scriptSetup?.content || ''}`)
  return cache(resolveWrapperTarget(tag, wrapperImports))
}
