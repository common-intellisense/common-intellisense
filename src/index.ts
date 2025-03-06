import type { Directives, PropsConfig, SubCompletionItem } from './ui/utils'
import fsp from 'node:fs/promises'
import { createFilter } from '@rollup/pluginutils'
import { CreateWebview } from '@vscode-use/createwebview'
import { addEventListener, createCompletionItem, createHover, createMarkdownString, createPosition, createRange, createSelect, getActiveText, getActiveTextEditor, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getLineText, getLocale, getPosition, getSelection, insertText, message, openExternalUrl, registerCommand, registerCompletionItemProvider, setConfiguration, setCopyText, updateText } from '@vscode-use/utils'
import * as vscode from 'vscode'
import { nameMap } from './constants'
import { cacheFetch, localCacheUri } from './fetch'
import { prettierType } from './prettier-type'
import { generateScriptNames, hyphenate, isVine, isVue, toCamel } from './ui/utils'
import { deactivateUICache, findUI, getCacheMap, getCurrentPkgUiNames, getOptionsComponents, getUiCompletions, logger } from './ui-find'
import { getAlias, getIsShowSlots, getUiDeps } from './ui-utils'
import { detectSlots, findDynamicComponent, findRefs, getImportDeps, getReactRefsMap, parser, parserVine, registerCodeLensProviderFn, transformVue } from './parser'

const defaultExclude = getConfiguration('common-intellisense.exclude')
const filterId = createFilter(defaultExclude)
const filter = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte']
function isSkip() {
  const id = getActiveTextEditorLanguageId()
  return !id || !filter.includes(id)
}
// todo: 补充类型
// todo: 补充example
export async function activate(context: vscode.ExtensionContext) {
  // todo: createWebviewPanel
  // createWebviewPanel(context)
  logger.info('common-intellisense activate!')
  logger.info('🌟 please help star this project: https://github.com/common-intellisense/common-intellisense')
  const isZh = getLocale().includes('zh')
  const LANS = ['javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'solid', 'swan', 'react', 'js', 'ts', 'tsx', 'jsx']
  const alias = getAlias()
  if (!isSkip())
    findUI(context, detectSlots)

  const provider = new CreateWebview(context, {
    viewColumn: vscode.ViewColumn.Beside,
    scripts: ['main.js'],
  })

  context.subscriptions.push(registerCommand('common-intellisense.cleanCache', () => {
    fsp.rmdir(localCacheUri)
    cacheFetch.clear()
    findUI(context, detectSlots)
  }))
  context.subscriptions.push(registerCodeLensProviderFn())

  context.subscriptions.push(addEventListener('activeText-change', (editor?: vscode.TextEditor) => {
    if (!editor || editor.document.languageId === 'Log')
      return

    if (isSkip())
      return
    // 找到当前活动的编辑器
    const visibleEditors = vscode.window.visibleTextEditors
    const currentEditor = visibleEditors.find(e => e === editor)
    if (currentEditor)
      findUI(context, detectSlots)
  }))

  context.subscriptions.push(registerCommand('intellisense.copyDemo', (demo) => {
    setCopyText(demo)
    message.info('copy successfully')
  }))

  context.subscriptions.push(registerCommand('common-intellisense.pickUI', () => {
    const currentPkgUiNames = getCurrentPkgUiNames()
    if (currentPkgUiNames && currentPkgUiNames.length) {
      if (currentPkgUiNames.some(i => i.includes('bitsUi'))) {
        currentPkgUiNames.filter(i => i.startsWith('bitsUi')).map(i => i.replace('bitsUi', 'shadcnSvelte')).forEach((i) => {
          if (!currentPkgUiNames!.includes(i))
            currentPkgUiNames!.push(i)
        })
      }
      const currentSelect = getConfiguration('common-intellisense.ui') as (string[] | undefined)
      let options: ({ label: string, picked?: boolean })[] = []
      if (currentSelect) {
        options = currentPkgUiNames.map((label) => {
          if (currentSelect.includes(label)) {
            return {
              label,
              picked: true,
            }
          }
          else {
            return {
              label,
            }
          }
        })
      }
      createSelect(options, {
        canSelectMany: true,
        placeHolder: isZh ? '请指定你需要提示的 UI 库' : 'Please specify the UI library you need to prompt.',
        title: 'common intellisense',
      }).then((data: string[]) => {
        setConfiguration('common-intellisense.ui', data)
      })
    }
    else {
      message.error(isZh
        ? '当前项目中并没有安装 common intellisense 支持的 UI 库'
        : 'There is no UI library supported by common intelligence in the current project.')
    }
  }))

  context.subscriptions.push(addEventListener('config-change', (e) => {
    if (e.affectsConfiguration('common-intellisense.ui'))
      findUI(context, detectSlots)
  }))

  context.subscriptions.push(registerCommand('common-intellisense.import', async (params, loc, _lineOffset) => {
    if (!params)
      return
    const { data, lib, prefix, dynamicLib, importWay } = params
    const name = data.name.split('.')[0]
    const fromName = data.from
    const from = fromName || dynamicLib ? dynamicLib.replace('${name}', hyphenate(name)) : lib
    const code = getActiveText()!
    const uiComponents = getImportUiComponents(code)
    let deps = data.suggestions?.length === 1
      ? data.suggestions.map((i: any) => {
          if (i.includes('-'))
            return toCamel(i).slice(prefix.length)

          return i
        })
      : []

    const importTarget = uiComponents[from]
    if (importTarget)
      deps.push(...uiComponents[from].components)
    else
      deps.push(name)

    deps = [...new Set(deps)]
    if (importTarget) {
      const line = importTarget.match[1].startsWith('\n')
      if (deps.includes(name))
        return
      deps.push(name)

      const offsetStart = code.match(importTarget.match[0])!.index!
      const offsetEnd = offsetStart + importTarget.match[0].length
      const posStart = getPosition(offsetStart).position
      const posEnd = getPosition(offsetEnd).position
      const str = importWay === 'as default'
        ? `import * as ${deps.join(', ')} from '${from}'`
        : importWay === 'default'
          ? `import ${deps.join(', ')} from '${from}'`
          : line
            ? `import {\n    ${deps.join(',\n    ')}\n  } from '${from}'`
            : `import { ${deps.join(', ')} } from '${from}'`
      updateText(edit => edit.replace(createRange(posStart, posEnd), str))
    }
    else {
      // 顶部导入
      const _isVue = isVue()
      let str = importWay === 'as default'
        ? `${_isVue ? '  ' : ''}import * as ${deps.join(', ')} from '${from}'`
        : importWay === 'default'
          ? `${_isVue ? '  ' : ''}import ${deps.join(', ')} from '${from}'`
          : `${_isVue ? '  ' : ''}import { ${deps.join(', ')} } from '${from}'`
      let pos: any = null
      if (_isVue) {
        if (loc) {
          if (getLineText(loc.start.line)?.trim()) {
            str += '\n'
          }
          pos = createPosition(loc.start.line, 0)
        }
        else {
          const match = code.match(/<script[^>]*>/)
          if (match) {
            const offset = match.index! + match[0].length
            pos = getPosition(offset)
            str = `\n${str}`
          }
          else {
            pos = createPosition(0, 0)
            str = `<script setup>\n${str}</script>`
          }
        }
      }
      else {
        const match = code.match(/<script[^>]*>/)
        if (match) {
          const offset = match.index! + match[0].length
          pos = getPosition(offset)
          str = `\n  ${str}`
        }
        else {
          str += '\n'
          pos = createPosition(0, 0)
        }
      }

      updateText(edit => edit.insert(pos, str))
    }
  }))

  // 监听pkg变化
  if (getIsShowSlots()) {
    context.subscriptions.push(registerCommand('common-intellisense.slots', async (child, name, offset, detail) => {
      const UiCompletions = getUiCompletions()
      const activeText = getActiveText()
      if (!activeText)
        return
      if (!child && UiCompletions) {
        const uiDeps = getUiDeps(activeText)
        const optionsComponents = getOptionsComponents()
        const componentsPrefix = optionsComponents.prefix
        detectSlots(UiCompletions, uiDeps, componentsPrefix)
        return
      }
      if (!child.children)
        return

      let lastChild = child.children[child.children.findLastIndex((c: any) => c.type !== 2)]
      let slotName = `#${name}`
      if (child.range)
        slotName = `v-slot:${name}`
      if (detail.params)
        slotName += '="slotProps"'

      if (lastChild) {
        if (isVine() && lastChild.codegenNode) {
          lastChild = lastChild.codegenNode
        }
        const pos = lastChild.loc.end
        const endColumn = Math.max(pos.column - 1, 0)
        if (isVine())
          await insertText(`\n<template ${slotName}>$1</template>`, getPosition(pos.offset + offset).position)
        else
          await insertText(`\n<template ${slotName}>$1</template>`, createPosition(pos.line - 1, endColumn))
      }
      else {
        const empty = ' '.repeat(Math.max(child.loc.start.column - 1, 0))

        if (child.isSelfClosing) {
          if (isVine())
            await insertText(`>\n  <template ${slotName}>$1</template>\n</${child.tag}>`, createRange(getPosition(child.loc.end.offset + offset - 3).position, getPosition(child.loc.end.offset + offset).position))
          else
            await insertText(`>\n  <template ${slotName}>$1</template>\n</${child.tag}>`, createRange(createPosition(child.loc.end.line - 1, child.loc.end.column - 3), createPosition(child.loc.end.line - 1, child.loc.end.column)))
        }
        else {
          const isNeedLineBlock = child.loc.start.line === child.loc.end.line
          const index = child.loc.start.offset + child.loc.source.indexOf(`</${child.tag}`) - (isNeedLineBlock ? 0 : (child.loc.end.column - `</${child.tag}>`.length - 1))
          const pos = getPosition(index)
          if (isVine())
            await insertText(`${isNeedLineBlock ? '\n' : empty}  <template ${slotName}>$1</template>\n`, getPosition(index + offset).position)
          else
            await insertText(`${isNeedLineBlock ? '\n' : empty}  <template ${slotName}>$1</template>\n`, createPosition(pos.line, pos.column))
        }
      }
    }))

    context.subscriptions.push(addEventListener('text-change', ({ contentChanges, document }) => {
      if (contentChanges.length === 0 || document.languageId === 'Log')
        return
      const UiCompletions = getUiCompletions()
      const optionsComponents = getOptionsComponents()
      const componentsPrefix = optionsComponents.prefix
      if (isSkip())
        return
      const activeText = getActiveText()
      if (UiCompletions && activeText) {
        const uiDeps = getUiDeps(activeText)
        detectSlots(UiCompletions, uiDeps, componentsPrefix)
      }
    }))
  }

  context.subscriptions.push(registerCompletionItemProvider(filter, async (document, position) => {
    const optionsComponents = getOptionsComponents()
    const componentsPrefix = optionsComponents.prefix
    let UiCompletions = getUiCompletions()
    if (!UiCompletions)
      return
    const { lineText } = getSelection()!
    const p = position
    const activeTextEditor = getActiveTextEditor()
    if (!activeTextEditor)
      return

    if (isSkip())
      return

    const preText = lineText.slice(0, activeTextEditor.selection.active.character)
    let completionsCallback: SubCompletionItem[] | undefined
    let eventCallback: SubCompletionItem[] | undefined
    const activeText = getEffectWord(preText)
    const result = parser(document.getText(), p)
    if (!result)
      return
    if (activeText === ':' && result.type === 'text')
      return

    const lan = getActiveTextEditorLanguageId()
    const isVue = (lan === 'vue' && result.template) || isVine()
    const code = getActiveText()
    if (!code)
      return
    const deps = isVue ? getImportDeps(code) : {}
    const uiDeps = getUiDeps(code)
    const { character } = position
    const isPreEmpty = lineText[character - 1] === ' '
    const isValue = result.isValue

    if (result.type === 'script' && Object.keys(result.refsMap || {}).length && !isPreEmpty) {
      if (lineText?.slice(-1)[0] === '.') {
        for (const key in result.refsMap) {
          const value = result.refsMap[key]
          if (isVue && (lineText.endsWith(`.$refs.${key}.`) || lineText.endsWith(`${key}.value.`)) && UiCompletions[value])
            return [...UiCompletions[value].methods, ...UiCompletions[value].exposed]
          else if (!isVue && lineText.endsWith(`${key}.current.`) && UiCompletions[value])
            return [...UiCompletions[value].methods, ...UiCompletions[value].exposed]
        }
      }
      if (isVue && lineText.slice(character, character + 6) !== '.value' && /\.value\.?$/.test(lineText.slice(0, character)))
        return result.refs.map((refName: string) => createCompletionItem({ content: refName, snippet: `${refName}.value`, documentation: `${refName}.value`, preselect: true, sortText: '0' }))

      if (!isVue && lineText.slice(character, character + 8) !== '.current' && /\.current\.?$/.test(lineText.slice(0, character)))
        return result.refs.map((refName: string) => createCompletionItem({ content: refName, snippet: `${refName}.current`, documentation: `${refName}.current`, preselect: true, sortText: '0' }))

      return
    }

    if (result.parent && result.tag === 'template') {
      const parentTag = result.parent.tag || result.parent.name
      if (parentTag) {
        const name = toCamel(parentTag)
        const component = UiCompletions[name[0].toUpperCase() + name.slice(1)]
        const slots = component?.slots
        if (slots)
          return slots
      }
    }

    if (UiCompletions && result?.type === 'props' && (!result.propType || result.propType && result.propType !== 'JSXAttribute')) {
      const name = result.tag[0].toUpperCase() + result.tag.replace(/(-\w)/g, (match: string) => match[1].toUpperCase()).slice(1)
      if (result.propName === 'icon')
        return UiCompletions.icons

      const propName = result.propName
      const from = uiDeps?.[name]
      const cacheMap = getCacheMap()
      if (from && cacheMap.size > 2) {
        // 存在多个 UI 库
        let fixedFrom = nameMap[from] || from
        if (fixedFrom in alias) {
          const v = alias[fixedFrom]
          fixedFrom = v.replace(/\d+$/, '')
        }

        const nameReg = new RegExp(`${toCamel(fixedFrom)}\\d+$`)
        const keys = Array.from(cacheMap.keys())
        const targetKey = keys.find(k => nameReg.test(k))!
        const targetValue = cacheMap.get(targetKey)! as PropsConfig
        UiCompletions = targetValue
      }
      let target = await findDynamicComponent(name, deps, UiCompletions, componentsPrefix, from)
      const importUiSource = uiDeps?.[name]
      if (importUiSource && (!target || target.uiName !== importUiSource)) {
        for (const p of optionsComponents.prefix.filter(Boolean)) {
          const realName = p[0].toUpperCase() + p.slice(1) + name
          const newTarget = UiCompletions[realName]
          if (!newTarget)
            continue
          if (newTarget.uiName === importUiSource) {
            target = newTarget
            break
          }
        }
      }

      if (!target) {
        if (result.isEvent && propName !== 'on') {
          const [options] = generateScriptNames(propName)
          return options.map(content => createCompletionItem({
            content,
            type: vscode.CompletionItemKind.Event,
            preselect: true,
            sortText: '0',
          }))
        }
        return
      }

      const { events, completions, uiName } = target
      const directives = optionsComponents.directivesMap[uiName]
      const directivesCompletions = directives
        ? directives.map((item: Directives[0]) => {
            const detail = isZh ? item.description_zh : item.description
            const content = `${item.name}  ${detail}`
            const documentation = createMarkdownString()
            if (item.documentation)
              documentation.appendMarkdown(item.documentation)
            else if (item.documentationType)
              documentation.appendCodeblock(item.documentationType, 'typescript')

            if (item.params?.length) {
              documentation.appendCodeblock('\n')
              item.params.forEach((i) => {
                documentation.appendMarkdown(`### 🌟 ${i.name}: \n`)
                documentation.appendMarkdown(`- ${isZh ? '类型' : 'type'}: ${i.type}\n`)
                documentation.appendMarkdown(`- ${isZh ? '描述' : 'description'}: ${isZh ? i.description_zh : i.description}\n`)
                documentation.appendMarkdown(`- ${isZh ? '默认值' : 'default'}: ${i.default}\n`)
              })
            }

            const snippet = item.params?.length
              ? `:${item.name}="${JSON.stringify(item.params.reduce((acc, i) => {
                const key = i.name
                const type = i.type.toLocaleLowerCase()
                const value = i.default || type === 'boolean' ? false : type === 'number' ? 0 : type === 'string' ? '' : ''
                acc[key] = value
                return acc
              }, {} as Record<string, any>), null, 2).replace(/"([^"]+)":/g, '$1:').replace(/"/g, '`')}"`
              : item.name

            return createCompletionItem({
              content,
              detail,
              sortText: '0',
              type: vscode.CompletionItemKind.Enum,
              snippet,
              params: [uiName, item.name],
              preselect: true,
              documentation,
            })
          })
        : []
      eventCallback = events[0](isVue) || []
      completionsCallback = [...completions[0](isVue), ...(isVue ? [] : eventCallback), ...directivesCompletions]

      const hasProps = result.props
        ? result.props.map((item: any) => {
            if (item.name === 'on' && item.arg)
              return `${item.arg.content}`

            if (typeof item.name === 'object' && item.name.name !== 'on')
              return item.name.name

            if (item.name === 'model' && item?.loc?.source?.startsWith('v-model'))
              return item.loc.source.split('=')[0]

            if (item.name === 'bind')
              return item?.arg?.content

            if (item.name !== 'on')
              return item.name

            return false
          }).filter(Boolean)
        : []
      if (propName === 'on') {
        return (eventCallback).filter((item: any) => !hasProps.find((prop: any) => item?.params?.[1] === prop))
      }
      else if (propName) {
        const r: any[] = []
        if (isValue) {
          completionsCallback.filter((item: any) => hasProps.find((prop: any) => item?.params?.[1] === prop)).filter((item: any) => {
            const reg = propName === 'bind'
              ? new RegExp('^:')
              : new RegExp(`^:?${propName}`)
            return reg.test(item.label)
          }).forEach((item: any) => {
            item.propType?.split('/').forEach((p: string) => {
              r.push(createCompletionItem({
                content: p.trim(),
                snippet: p.trim().replace(/'`/g, ''),
                documentation: item.documentation,
                sortText: '0',
                preselect: true,
                detail: item.detail,
                type: item.kind,
              }))
            })
          })
          return r
        }
        else {
          r.push(...(completionsCallback ?? []).filter((item: any) => !hasProps.find((prop: any) => item?.params?.[1] === prop)).map((item: any) => createCompletionItem(({
            content: item.content,
            snippet: item.snippet,
            documentation: item.documentation,
            detail: item.detail,
            sortText: '0',
            preselect: true,
            type: item.kind,
          }))))
        }
        const events = isVue
          ? []
          : isValue
            ? []
            : eventCallback.filter((item: any) => !hasProps.find((prop: any) => item?.params?.[1] === prop))
        if (propName === 'o')
          return [...events, ...r]

        if ([...r, ...events].length)
          return [...r, ...events]
        if (result.isEvent && propName !== 'on') {
          const [options] = generateScriptNames(propName)
          return options.map(content => createCompletionItem({
            content,
            type: vscode.CompletionItemKind.Event,
          }))
        }
      }
      else if (hasProps.length) {
        return (completionsCallback ?? []).filter((item: any) => !hasProps.find((prop: any) => item.params?.[1] === prop))
      }
      else {
        return completionsCallback
      }
    }
    else if (!result.isInTemplate || isPreEmpty || !optionsComponents) {
      return
    }
    const prefix = lineText.trim().split(' ').slice(-1)[0]
    if (prefix.toLowerCase() === prefix ? optionsComponents.prefix.some((reg: string) => prefix.startsWith(reg) || reg.startsWith(prefix)) : true) {
      const parent = result.parent
      const data = await Promise.all(optionsComponents.data.map(c => c(parent)).flat())
      if (parent) {
        const parentTag = parent.tag || parent.name
        if (UiCompletions) {
          const suggestions = UiCompletions[parentTag[0].toUpperCase() + toCamel(parentTag).slice(1)]?.suggestions
          if (suggestions && suggestions.length) {
            data.forEach((child) => {
              const label = typeof child.label === 'string' ? child.label.split(' ')[0] : child.label.label.split(' ')[0]
              child.sortText = suggestions.includes(label) ? '1' : '2';
              (child as any).loc = result.loc
            })
          }
          else {
            data.forEach((child: any) => {
              child.sortText = '2'
              child.loc = result.loc
            })
          }
        }
      }

      return data
    }
  }, (item: SubCompletionItem) => {
    if (!item.command) {
      if (item.params?.isReact) {
        item.command = {
          title: 'common-intellisense-import',
          command: 'common-intellisense.import',
          arguments: [item.params, item.loc, (item.snippet || item.content).split('\n').length - 1],
        }
      }
      else {
        item.command = {
          title: 'common-intellisense.slots',
          command: 'common-intellisense.slots',
          arguments: [],
        }
      }
    }

    return item
  }, ['"', '\'', '-', ' ', '@', '.', ':', '\n']))

  context.subscriptions.push(registerCommand('intellisense.openDocument', (args) => {
    // 注册全局的 link 点击事件
    const url = args.link
    if (!url)
      return
    provider.create(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Webview</title>
          <style>
            body{
              width:100%;
              height:100vh;
            }
          </style>
        </head>
        <body>
          <iframe src="${url}" width="100%" height="100%"></iframe>
        </body>
      </html>
      `, ({ data, type }) => {
      // callback 获取 js 层的 postMessage 数据
      if (type === 'copy') {
        setCopyText(data).then(() => {
          const isZh = getLocale().includes('zh')
          message.info(`${isZh ? '复制成功' : 'copy successfully'}!  ✅`)
        })
      }
    })
  }))

  context.subscriptions.push(registerCommand('intellisense.openDocumentExternal', (args) => {
    // 注册全局的 link 点击事件
    const url = args.link
    if (!url)
      return
    openExternalUrl(url)
  }))

  context.subscriptions.push(vscode.languages.registerHoverProvider(LANS, {
    async provideHover(document, position) {
      const optionsComponents = getOptionsComponents()
      const componentsPrefix = optionsComponents.prefix
      let UiCompletions = getUiCompletions()
      if (!optionsComponents || !UiCompletions)
        return

      const editor = getActiveTextEditor()
      if (!editor)
        return

      const currentFileUrl = getCurrentFileUrl()

      if (!currentFileUrl)
        return

      if (filterId(currentFileUrl))
        return

      const range = document.getWordRangeAtPosition(position)
      if (!range)
        return

      let word = document.getText(range)

      const lineText = getLineText(position.line)
      if (!lineText)
        return

      const code = document.getText()
      const uiDeps = getUiDeps(code)
      // word 修正
      if (lineText[range.end.character] === '.' || lineText[range.end.character] === '-') {
        let index = range.end.character
        while (!/[>\s/]/.test(lineText[index]) && index < lineText.length) {
          word += lineText[index]
          index++
        }
      }
      if (lineText[range.start.character - 1] === '.') {
        let index = range.start.character - 1
        while (!/[<\s/]/.test(lineText[index]) && index >= 0) {
          word = lineText[index] + word
          index--
        }
      }
      else if (lineText[range.start.character - 1] !== '<') {
        const result = parser(code, position as any)
        if (!result)
          return
        if (result.type === 'tag') {
          const data = await Promise.all(optionsComponents.data.map(c => c()).flat())
          if (!data?.length || !word)
            return createHover('')
          const tag = result.tag[0].toUpperCase() + toCamel(result.tag).slice(1)
          const target = await findDynamicComponent(tag, {}, UiCompletions, componentsPrefix, uiDeps?.[tag])
          if (!target)
            return

          const tableDocument = target.tableDocument

          if (tableDocument)
            return createHover(tableDocument)
        }
        else if (result.type === 'props' && result.tag === 'template') {
          const parentTag = result.parent.tag
          if (!parentTag)
            return

          const name = parentTag[0].toUpperCase() + toCamel(parentTag).slice(1)
          const slotName = result.props.find((item: any) => item.name === 'slot')?.arg?.content

          if (!slotName)
            return

          const from = uiDeps?.[name]
          const cacheMap = getCacheMap()

          if (from && cacheMap.size > 2) {
            // 存在多个 UI 库
            let fixedFrom = nameMap[from] || from
            if (fixedFrom in alias) {
              const v = alias[fixedFrom]
              fixedFrom = v.replace(/\d+$/, '')
            }

            const nameReg = new RegExp(`${toCamel(fixedFrom)}\\d+$`)
            const keys = Array.from(cacheMap.keys())
            const targetKey = keys.find(k => nameReg.test(k))!
            const targetValue = cacheMap.get(targetKey)! as PropsConfig
            UiCompletions = targetValue
          }
          const target = await findDynamicComponent(name, {}, UiCompletions, componentsPrefix, from)
          if (!target)
            return
          const targetSlot = target.rawSlots?.find(s => s.name === slotName)
          const params = targetSlot?.params
          if (!params)
            return
          const md = createMarkdownString()
          md.appendMarkdown(`## ${target.lib} [${targetSlot.name}]\n`)
          md.appendMarkdown(`#### ${isZh ? '说明' : 'description'}: ${isZh ? targetSlot.description_zh : targetSlot.description}\n`)
          md.appendMarkdown(`#### ${isZh ? '插槽 props' : 'slotProps'}: \n`)
          const typeString = `interface SlotProps ${params}`
          md.appendCodeblock(prettierType(typeString), 'typescript')
          return createHover(md)
        }
        else if (!result.propName) {
          return
        }
        // 这个实现有些问题，要从底层去修改 propName 上的信息，才能拿到准确的数据
        const findBind = () => result.props.find((p: any) => p.name === 'bind')
        const findOn = () => result.props.find((p: any) => p.name === 'on')
        const propName = result.propName === true ? result.props[0].name === 'on' ? findOn().arg.content : findBind().arg.content : result.propName

        if (typeof propName !== 'string')
          return

        if (['class', 'className', 'style', 'id'].includes(propName))
          return
        const tag = toCamel(result.tag)[0].toUpperCase() + toCamel(result.tag).slice(1)
        const r = UiCompletions[tag] || await findDynamicComponent(tag, {}, UiCompletions, componentsPrefix, uiDeps?.[tag])
        if (!r)
          return
        const completions = result.isEvent ? r.events[0]?.() : r.completions[0]?.()
        if (!completions)
          return

        const detail = getHoverAttribute(completions, propName)
        if (!detail)
          return
        return createHover(`## Details \n\n${detail}`)
      }
      // todo: 优化这里的条件，在 react 中， 也可以减少更多的处理步骤
      if (isVue()) {
        const r = transformVue(code, position)
        if (r) {
          if (!r.template)
            return
          if (word.includes('.value.') && r.type === 'script' && r.refs.length) {
            const refsMap = findRefs(r.template, r.refs)
            const index = word.indexOf('.value.')
            const key = word.slice(0, index)
            const refName = refsMap[key]
            if (!refName)
              return

            if (lineText.slice(range.start.character, range.end.character) === 'value') {
              // hover .value.区域 提示所有方法
              const groupMd = createMarkdownString()
                ;[...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].forEach((m, i) => {
                let content = typeof m.documentation === 'string' ? m.documentation : m.documentation?.value || ''
                if (i !== 0) {
                  content = content.replace(/##[^\]\n]*[\]\n]/, '')
                }
                groupMd.appendMarkdown(content)
                groupMd.appendMarkdown('\n')
              })

              return createHover(groupMd)
            }
            const targetKey = word.slice(index + '.value.'.length)
            // FIXME: label可能是对象,string | vscode.CompletionItemLabel
            const target = [...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].find(item => item.label === targetKey)

            if (!target)
              return

            return target.hover
          }
          if (r.type === 'script')
            return
        }
      }
      else if (isVine()) {
        const r = parserVine(code, position)
        if (r) {
          if (word.includes('.value.') && r.type === 'script' && Object.keys(r.refsMap || {}).length) {
            const index = word.indexOf('.value.')
            const key = word.slice(0, index)
            const refName = r.refsMap[key]
            if (!refName)
              return
            if (lineText.slice(range.start.character, range.end.character) === 'value') {
              // hover .value.区域 提示所有方法
              const groupMd = createMarkdownString()
                ;[...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].forEach((m: any, i: number) => {
                let content = m.documentation.value
                if (content && i !== 0) {
                  content = content.replace(/##[^\]\n]*[\]\n]/, '')
                }
                groupMd.appendMarkdown(content)
                groupMd.appendMarkdown('\n')
              })
              return createHover(groupMd)
            }
            const targetKey = word.slice(index + '.value.'.length)
            const target = [...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].find((item: any) => item.label === targetKey)

            if (!target)
              return

            return target.hover
          }
          if (r.type === 'script')
            return
        }
      }
      else if (getActiveTextEditorLanguageId()?.includes('react')) {
        if (word.includes('.current.')) {
          const r = getReactRefsMap()
          const index = word.indexOf('.current.')
          const key = word.slice(0, index)
          const refName = r.refsMap[key]
          if (!refName)
            return

          if (lineText.slice(range.start.character, range.end.character) === 'current') {
            // hover .value.区域 提示所有方法
            const groupMd = createMarkdownString()
              ;[...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].forEach((m, i) => {
              let content = typeof m.documentation === 'string' ? m.documentation : m.documentation?.value || ''
              if (i !== 0) {
                content = content.replace(/##[^\]\n]*[\]\n]/, '')
              }
              groupMd.appendMarkdown(content)
              groupMd.appendMarkdown('\n')
            })
            return createHover(groupMd)
          }
          const targetKey = word.slice(index + '.current.'.length)
          const target = [...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].find(item => item.label === targetKey)

          if (!target)
            return

          return target.hover
        }
      }
      const data = await Promise.all(optionsComponents.data.map(c => c()).flat())
      if (!data?.length || !word)
        return createHover('')
      word = toCamel(word)[0].toUpperCase() + toCamel(word).slice(1)
      const from = uiDeps?.[word]
      const cacheMap = getCacheMap()
      if (from && cacheMap.size > 2) {
        // 存在多个 UI 库
        let fixedFrom = nameMap[from] || from
        if (fixedFrom in alias) {
          const v = alias[fixedFrom]
          fixedFrom = v.replace(/\d+$/, '')
        }

        const nameReg = new RegExp(`${toCamel(fixedFrom)}\\d+$`)
        const keys = Array.from(cacheMap.keys())
        const targetKey = keys.find(k => nameReg.test(k))!
        const targetValue = cacheMap.get(targetKey)! as PropsConfig
        UiCompletions = targetValue
      }
      const target = await findDynamicComponent(word, {}, UiCompletions, optionsComponents.prefix, uiDeps?.[word])
      if (!target)
        return

      const tableDocument = target.tableDocument

      if (tableDocument)
        return createHover(tableDocument)
    },
  }))
}

export function deactivate() {
  deactivateUICache()
}

function getEffectWord(preText: string) {
  let i = preText.length - 1
  let active = ''
  while (preText[i] && (preText[i] !== ' ')) {
    active = `${preText[i]}${active}`
    i--
  }
  return active
}

function getHoverAttribute(attributeList: any[], attr: string) {
  return attributeList.filter(a =>
    toCamel(a?.params?.[1]?.replace('v-model:', '') || '') === toCamel(attr),
  ).map(i => `- ${i.details}`).join('\n\n')
}

const IMPORT_UI_REG = /import\s+\{([^}]+)\}\s+from\s+['"]([^"']+)['"]/g

function getImportUiComponents(text: string) {
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
