import type { SFCTemplateBlock } from '@vue/compiler-sfc'
import type { VineCompilerHooks, VineDiagnostic, VineFileCtx } from '@vue-vine/compiler'
import type { PropsConfig, PropsConfigItem } from './ui/utils'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parse as babelParse } from '@babel/parser'
import traverse from '@babel/traverse'
import { parse as tsParser } from '@typescript-eslint/typescript-estree'
import { createRange, getActiveText, getActiveTextEditor, getCurrentFileUrl, getLocale, getPosition, isInPosition, registerCodeLensProvider } from '@vscode-use/utils'
// @ts-expect-error no problem
import { parse } from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
import {
  compileVineTypeScriptFile,
  createCompilerCtx,
} from '@vue-vine/compiler'

import * as vscode from 'vscode'
import { nameMap } from './constants'
import { convertPrefixedComponentName, findPrefixedComponent, hyphenate, toCamel } from './ui/utils'
import { logger } from './ui/ui-find'

const { parse: svelteParser } = require('svelte/compiler')

// 引入vue-parser只在template中才处理一些逻辑
let isInTemplate = false
interface VineFileCtxResult {
  vineFileCtx: VineFileCtx
  vineCompileErrs: VineDiagnostic[]
  vineCompileWarns: VineDiagnostic[]
}

let vueSfcParseCache: { code: string, value: ReturnType<typeof parse> } | null = null
let jsxAstCache: { code: string, value: any } | null = null
let svelteHtmlCache: { code: string, value: any } | null = null
let vineCtxCache: { key: string, value: VineFileCtxResult } | null = null
let lineIndexCache: { code: string, starts: number[] } | null = null

function getVueSfcParseResult(code: string) {
  if (vueSfcParseCache?.code === code)
    return vueSfcParseCache.value
  const value = parse(code)
  vueSfcParseCache = { code, value }
  return value
}

function getJsxAst(code: string) {
  if (jsxAstCache?.code === code)
    return jsxAstCache.value
  const value = tsParser(code, { jsx: true, loc: true, range: true })
  jsxAstCache = { code, value }
  return value
}

function getSvelteHtml(code: string) {
  if (svelteHtmlCache?.code === code)
    return svelteHtmlCache.value
  const { html } = svelteParser(code)
  svelteHtmlCache = { code, value: html }
  return html
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
  if (activeScript?.lang === 'tsx') {
    const relativeOffset = Math.max(0, Math.min(cursorOffset - activeScript.loc.start.offset, activeScript.content.length))
    const result = parserJSX(activeScript.content, getSourcePosition(activeScript.content, relativeOffset))
    if (result) {
      result.loc = activeScript.loc
      result.template = template
      result.hostFramework = 'vue'
    }
    return result
  }
  if (activeScript) {
    return {
      type: 'script',
      refs: collectVueTemplateRefs(scripts),
      template,
      loc: activeScript.loc,
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
    r.loc = (scriptSetup || script)?.loc
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
    return Object.assign(result, refsMap)

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
      if (child.declaration.type === 'FunctionDeclaration')
        children = child.declaration.body.body
      else
        children = child.declaration.arguments
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
      if (child.declaration.type === 'FunctionDeclaration') {
        children = child.declaration.body.body
      }
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
    documentSlotAnalyses.delete(oldest)
    latestSlotRequests.delete(oldest)
  }
  refreshCodeLenses()
  return true
}

export async function detectSlots(document: vscode.TextDocument, UiCompletions: any, uiDeps: any, prefix: string[], identity?: SlotAnalysisIdentity): Promise<void>
export async function detectSlots(UiCompletions: any, uiDeps: any, prefix: string[]): Promise<void>
export async function detectSlots(documentOrCompletions: vscode.TextDocument | any, completionsOrDeps: any, depsOrPrefix: any, maybePrefix?: string[], maybeIdentity?: SlotAnalysisIdentity) {
  const hasDocument = documentOrCompletions?.uri && typeof documentOrCompletions.getText === 'function'
  const document = hasDocument ? documentOrCompletions as vscode.TextDocument : getActiveTextEditor()?.document
  if (!document)
    return
  const UiCompletions = hasDocument ? completionsOrDeps : documentOrCompletions
  const uiDeps = hasDocument ? depsOrPrefix : completionsOrDeps
  const prefix = (hasDocument ? maybePrefix : depsOrPrefix) || []
  const identity = hasDocument ? maybeIdentity : undefined
  const request = beginDocumentSlotAnalysis(document.uri, document.version, identity || { packagePath: '', contextGeneration: 0, contextRevision: 0 })
  const children = (await getTemplateAst(document, UiCompletions, uiDeps, prefix)).filter(item => item.children.length)

  if (document.version !== request.documentVersion)
    return
  commitDocumentSlotAnalysis(request, children)
}

export function registerCodeLensProviderFn() {
  const isZh = getLocale().includes('zh')
  return registerCodeLensProvider(['vue', 'javascriptreact', 'typescriptreact', 'typescript'], {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(document: vscode.TextDocument) {
      const languageId = document.languageId
      const isVineDocument = document.uri.toString().endsWith('.vine.ts')
      if (languageId === 'typescript' && !isVineDocument)
        return []
      const result: vscode.CodeLens[] = []
      const analysis = getDocumentSlotAnalysis(document.uri)
      if (!analysis || analysis.documentVersion !== document.version)
        return result
      const children = analysis.children
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
            // 计算偏移量
            let codeLensRange = null
            if (offset) {
              const fixedStart = getPosition(range.start.offset + offset, document.getText()).position
              const fixedEnd = getPosition(range.end.offset + offset, document.getText()).position
              codeLensRange = createRange(fixedStart, fixedEnd)
            }
            else {
              codeLensRange = createRange(range.start.line - 1, range.start.column, range.end.line - 1, range.end.column)
            }

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

async function getTemplateAst(document: vscode.TextDocument, UiCompletions: any, uiDeps: any, prefix: string[]): Promise<Array<{ children: any, offset: number }>> {
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
        children: await findUiTag(template.ast.children, UiCompletions, [], new Set(), uiDeps, prefix),
        offset: 0,
      })
    }
    const tsxScript = [scriptSetup, script].find(block => block?.lang === 'tsx')
    if (tsxScript) {
      const children = findAllJsxElements(tsxScript.content)
      analyses.push({
        children: await findUiTag(children, UiCompletions, [], new Set(), uiDeps, prefix),
        offset: tsxScript.loc.start.offset,
      })
    }
    return analyses
  }
  else if (isVineDocument) {
    const { vineFileCtx } = createVineFileCtx('', code)
    if (!vineFileCtx.vineCompFns)
      return []

    return await Promise.all(vineFileCtx.vineCompFns.map(async (item: any) => {
      const r = {
        children: await findUiTag(item.templateAst?.children, UiCompletions, [], new Set(), uiDeps, prefix),
        offset: item.templateStringNode?.quasi.quasis[0].start || 0,
      }
      return r
    })) as any
  }
  else if (['javascriptreact', 'typescriptreact'].includes(document.languageId)) {
    const children = findAllJsxElements(code)
    return [{
      children: await findUiTag(children, UiCompletions, [], new Set(), uiDeps, prefix),
      offset: 0,
    }]
  }
  return []
}
const originTag = ['div', 'span', 'ul', 'li', 'ol', 'p', 'main', 'header', 'footer', 'template', 'img', 'aside', 'body', 'a', 'video', 'table', 'th', 'tr', 'td', 'form', 'input', 'label', 'button', 'article', 'section']

export async function findUiTag(children: any, UiCompletions: any, result: any[] = [], cacheMap = new Set(), uiDeps: any = {}, prefix: string[] = []) {
  for (const child of children) {
    let tag: string | undefined = child.tag
    if (child.type === 'JSXElement')
      tag = getJsxElementName(child.openingElement?.name)

    if (!tag)
      continue
    const nextChildren = child.children

    if (nextChildren?.length)
      await findUiTag(nextChildren, UiCompletions, result, cacheMap, uiDeps, prefix)
    const range = child.range ?? child.loc

    if (cacheMap.has(range))
      continue
    if (originTag.includes(tag))
      continue

    // Use utility function to handle prefix matching
    const matchedComponent = findPrefixedComponent(tag, prefix.filter(Boolean), UiCompletions)
    if (matchedComponent) {
      if (!matchedComponent.rawSlots?.length)
        continue
      cacheMap.add(range)
      result.push({
        child,
        slots: matchedComponent.rawSlots,
      })
      continue
    }

    // Fallback to standard conversion if no prefix match
    const tagName = tag[0]?.toUpperCase() + toCamel(tag.slice(1))
    let target = UiCompletions[tagName] || await findDynamicComponent(tagName, {}, UiCompletions, prefix)
    const importUiSource = uiDeps[tagName]
    if (!target)
      continue
    if (importUiSource && target.uiName !== importUiSource) {
      for (const p of prefix.filter(Boolean)) {
        const realName = p[0].toUpperCase() + p.slice(1) + tagName
        const newTarget = UiCompletions[realName]
        if (!newTarget)
          continue
        if (newTarget.uiName === importUiSource) {
          target = newTarget
          break
        }
      }
    }
    if (!target || !target.rawSlots?.length)
      continue
    cacheMap.add(range)
    result.push({
      child,
      slots: target.rawSlots,
    })
  }
  return result
}

function findAllJsxElements(code: string) {
  const results: any = []
  try {
    const ast = getJsxAst(code) as any
    traverse(ast, (node: any) => {
      if (node.type === 'JSXElement') {
        results.push(node)
      }
      else if (node.type === 'ObjectExpression') {
        const _node: any = node.properties?.find((p: any) => p?.key?.name === 'render')
          || node.properties?.find((p: any) => p?.key?.name === 'setup')
        const t = _node?.value
        if (t) {
          traverse(t, (nextNode: any) => {
            if (nextNode.type === 'JSXElement') {
              const tag = (nextNode.openingElement.name as any)?.name
              if (tag && !originTag.includes(tag))
                results.push(nextNode)
            }
          })
        }
      }
    })
  }
  catch (error) {
    logger.error(JSON.stringify(error))
  }
  finally {
  // eslint-disable-next-line no-unsafe-finally
    return results
  }
}

export function parserVine(code: string, position: vscode.Position, cursorOffset = getSourceOffset(code, position)) {
  const { vineFileCtx } = createVineFileCtx('', code)
  if (!vineFileCtx.vineCompFns.length)
    return

  return transformVine(vineFileCtx, position, cursorOffset)
}

export function createVineFileCtx(sourceFileName: string, source: string): VineFileCtxResult {
  const key = `${sourceFileName}\0${source}`
  if (vineCtxCache?.key === key)
    return vineCtxCache.value

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
  vineCtxCache = { key, value }
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

export function getImportDeps(text: string) {
  const deps: Record<string, string> = {}
  try {
    const { descriptor: { script, scriptSetup } } = getVueSfcParseResult(text)
    let scriptContent = ''
    if (script && script.content)
      scriptContent += script.content
    if (scriptSetup && scriptSetup.content)
      scriptContent += `\n${scriptSetup.content}`

    const findImportSource = (node: any): string | null => {
      if (!node)
        return null
      if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Import') {
        return node.arguments?.[0]?.value || null
      }
      if (node.type === 'ImportExpression' || node.type === 'Import') {
        return node.source?.value || (node.arguments && node.arguments[0]?.value) || null
      }
      if (node.type === 'MemberExpression')
        return findImportSource(node.object)
      if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
        return findImportSource(node.body)
      }
      if (node.type === 'BlockStatement') {
        const ret = node.body.find((n: any) => n.type === 'ReturnStatement')
        return findImportSource(ret && ret.argument)
      }
      return null
    }

    if (!scriptContent) {
      // If there's no <script> or <script setup> (e.g., plain .tsx/.jsx files),
      // attempt to parse the raw text to extract import declarations.
      const astRaw = babelParse(text, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
      })

      traverse(astRaw as any, {
        ImportDeclaration(p: any) {
          const source = p.node.source.value
          if (!/^[./@]/.test(source))
            return
          for (const spec of p.node.specifiers) {
            if (spec.type === 'ImportDefaultSpecifier')
              deps[spec.local.name] = source
            else if (spec.type === 'ImportSpecifier')
              deps[spec.local.name] = source
            else if (spec.type === 'ImportNamespaceSpecifier')
              deps[spec.local.name] = source
          }
        },
        VariableDeclarator(p: any) {
          try {
            const id = p.node.id
            const init = p.node.init
            if (!id || !init)
              return

            if (init.type === 'CallExpression' && init.callee && init.callee.type === 'Import') {
              const source = init.arguments?.[0]?.value
              if (source && id.name)
                deps[id.name] = source
              return
            }

            if (init.type === 'ImportExpression' || init.type === 'Import') {
              const source = init.source?.value || (init.arguments && init.arguments[0]?.value)
              if (source && id.name)
                deps[id.name] = source
              return
            }

            if (init.type === 'CallExpression' && init.callee && init.callee.name === 'defineAsyncComponent') {
              const arg = init.arguments && init.arguments[0]
              if (arg) {
                const source = findImportSource(arg)
                if (source && id.name)
                  deps[id.name] = source
              }
            }
          }
          catch {
            // ignore
          }
        },
        ExportDefaultDeclaration(p: any) {
          const decl = p.node.declaration
          if (!decl || decl.type !== 'ObjectExpression')
            return
          for (const prop of decl.properties) {
            if (prop.type !== 'ObjectProperty')
              continue
            const keyName = prop.key && (prop.key.name || prop.key.value)
            if (keyName !== 'components')
              continue
            const val = prop.value
            if (val.type === 'ObjectExpression') {
              for (const entry of val.properties) {
                if (entry.type !== 'ObjectProperty')
                  continue
                const localName = entry.key.name || entry.key.value
                if (entry.value.type === 'Identifier') {
                  const ref = entry.value.name
                  if (deps[ref])
                    deps[localName] = deps[ref]
                  else
                    deps[localName] = ref
                }
                else if (entry.value.type === 'ObjectExpression') {
                  deps[localName] = localName
                }
                else {
                  deps[localName] = localName
                }
              }
            }
          }
        },
      })

      return deps
    }

    const ast = babelParse(scriptContent, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })

    traverse(ast as any, {
      ImportDeclaration(p: any) {
        const source = p.node.source.value
        if (!/^[./@]/.test(source))
          return
        for (const spec of p.node.specifiers) {
          if (spec.type === 'ImportDefaultSpecifier')
            deps[spec.local.name] = source
          else if (spec.type === 'ImportSpecifier')
            deps[spec.local.name] = source
          else if (spec.type === 'ImportNamespaceSpecifier')
            deps[spec.local.name] = source
        }
      },
      ExportDefaultDeclaration(p: any) {
        const decl = p.node.declaration
        if (!decl || decl.type !== 'ObjectExpression')
          return
        for (const prop of decl.properties) {
          if (prop.type !== 'ObjectProperty')
            continue
          const keyName = prop.key && (prop.key.name || prop.key.value)
          if (keyName !== 'components')
            continue
          const val = prop.value
          if (val.type === 'ObjectExpression') {
            for (const entry of val.properties) {
              if (entry.type !== 'ObjectProperty')
                continue
              const localName = entry.key.name || entry.key.value
              if (entry.value.type === 'Identifier') {
                const ref = entry.value.name
                if (deps[ref])
                  deps[localName] = deps[ref]
                else
                  deps[localName] = ref
              }
              else if (entry.value.type === 'ObjectExpression') {
                deps[localName] = localName
              }
              else {
                deps[localName] = localName
              }
            }
          }
        }
      },
    })
  }
  catch {
    const clean = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
    for (const match of clean.matchAll(IMPORT_VUE_REG)) {
      if (!match)
        continue
      deps[match[1]] = match[2]
    }
  }

  return deps
}

export function getAbsoluteUrl(url: string, currentFileUrl?: string) {
  const base = currentFileUrl || getCurrentFileUrl()
  return base ? path.resolve(base, '..', url) : undefined
}

export async function findDynamicComponent(name: string, deps: Record<string, string>, UiCompletions: PropsConfig, prefix: string[], from?: string, currentFileUrl?: string) {
  // const prefix = optionsComponents.prefix
  let target = findDynamic(name, UiCompletions, prefix, from)
  if (target)
    return target

  let dep
  if (dep = deps[name]) {
    // 只往下找一层
    const absoluteUrl = getAbsoluteUrl(dep, currentFileUrl)
    if (!absoluteUrl)
      return
    const tag = await getTemplateParentElementName(absoluteUrl)
    if (!tag)
      return
    target = findDynamic(tag, UiCompletions, prefix, from)
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

async function getTemplateParentElementName(url: string) {
  const code = await fsp.readFile(url, 'utf-8')
  // 如果有defineProps或者props的忽律，交给v-component-prompter处理
  const {
    descriptor: { template, script, scriptSetup },
  } = getVueSfcParseResult(code)

  if (script?.content && /^\s*props:\s*\{/.test(script.content))
    return
  if (scriptSetup?.content && /defineProps\(/.test(scriptSetup.content))
    return
  if (!template?.ast?.children?.length)
    return

  let result = ''
  for (const child of template.ast.children) {
    const node = child as any
    if (node.tag) {
      if (result) // 说明template下不是唯一父节点
        return
      result = node.tag
    }
  }
  return result
}
