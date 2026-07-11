import type { CompletionRenderContext, Directives, PropsConfig, SubCompletionItem } from './ui/utils'
import fsp from 'node:fs/promises'
import { createFilter } from '@rollup/pluginutils'
import { addEventListener, createCompletionItem, createHover, createMarkdownString, createPosition, createRange, createSelect, getActiveTextEditor, getConfiguration, getLocale, getPosition, insertText, message, openExternalUrl, registerCommand, registerCompletionItemProvider, setConfiguration, setCopyText, updateText } from '@vscode-use/utils'
import * as vscode from 'vscode'
import { nameMap } from './constants'
import { awaitCacheWrites, clearFetchCaches, configureCacheStorage, getLocalCache, localCacheUri } from './services/fetch'
import { createImportEdits, getSuggestedImportNames, resolveImportSource } from './services/imports'
import { prettierType } from './prettier-type'
import { findPrefixedComponent, generateScriptNames, isVine, toCamel } from './ui/utils'
import { deactivateUICache, ensureContextForPath, getContextForDocumentPath, getContextForPackagePath, invalidateContexts, logger, onPackageContextsInvalidated, onPackageContextUpdated, resolvePackagePathForDocument } from './ui/ui-find'
import { fixedTagName, getAlias, getIsShowSlots, getSelectedUIs, getUiDeps } from './ui/ui-utils'
import { clearDocumentAnalysis, detectSlots, findDynamicComponent, getDocumentSlotAnalysis, getImportDeps, parser, registerCodeLensProviderFn } from './parser'

const filter = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte']
interface DocumentAnalysisCacheEntry {
  uri: string
  version: number
  code: string
  uiDeps?: Record<string, string>
  importDeps?: Record<string, string>
}
const documentAnalysisCache = new Map<string, DocumentAnalysisCacheEntry>()
const maxDocumentAnalysisEntries = 10

export function getDocumentAnalysis(document: vscode.TextDocument) {
  const uri = document.uri.toString()
  const key = `${uri}:${document.version}`
  let entry = documentAnalysisCache.get(key)
  if (!entry) {
    entry = { uri, version: document.version, code: document.getText() }
    documentAnalysisCache.set(key, entry)
    while (documentAnalysisCache.size > maxDocumentAnalysisEntries)
      documentAnalysisCache.delete(documentAnalysisCache.keys().next().value!)
  }
  return {
    get code() {
      return entry!.code
    },
    getUiDeps() {
      entry!.uiDeps ||= getUiDeps(entry!.code) || {}
      return entry!.uiDeps
    },
    getImportDeps() {
      entry!.importDeps ||= getImportDeps(entry!.code) || {}
      return entry!.importDeps
    },
  }
}

export function clearLocalDocumentAnalysis(uri: string | vscode.Uri) {
  const keyPrefix = `${typeof uri === 'string' ? uri : uri.toString()}:`
  for (const key of documentAnalysisCache.keys()) {
    if (key.startsWith(keyPrefix))
      documentAnalysisCache.delete(key)
  }
}

function isExcluded(filePath: string) {
  return createFilter(getConfiguration('common-intellisense.exclude') || [])(filePath)
}

function isSkip(document?: vscode.TextDocument) {
  const id = document?.languageId || vscode.window.activeTextEditor?.document.languageId
  return !id || !filter.includes(id)
}

function getDocumentPath(document: vscode.TextDocument) {
  return document.uri.fsPath || document.uri.toString()
}

function getDocumentWorkspaceRoot(document: vscode.TextDocument) {
  return vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath
}

function getDocumentOffset(document: vscode.TextDocument, position: vscode.Position, code = document.getText()) {
  if (typeof document.offsetAt === 'function')
    return document.offsetAt(position)
  const lines = code.split('\n')
  return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character
}

function getCompletionRenderContext(document: vscode.TextDocument): CompletionRenderContext {
  const isVineDocument = document.uri.fsPath.endsWith('.vine.ts')
  return {
    languageId: document.languageId,
    framework: isVineDocument ? 'vine' : document.languageId === 'vue' ? 'vue' : document.languageId === 'svelte' ? 'svelte' : 'react',
    uri: document.uri.toString(),
  }
}
// todo: 补充类型
// todo: 补充example
export async function activate(context: vscode.ExtensionContext) {
  configureCacheStorage(context.globalStorageUri)
  // todo: createWebviewPanel
  // createWebviewPanel(context)
  logger.info('common-intellisense activate!')
  logger.info('🌟 please help star this project: https://github.com/common-intellisense/common-intellisense')
  const isZh = getLocale().includes('zh')
  const LANS = ['javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'solid', 'swan', 'react', 'js', 'ts', 'tsx', 'jsx']
  const initialEditor = vscode.window.activeTextEditor
  const slotTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const ensureDocumentContext = (document: vscode.TextDocument, cleanCache = false) => ensureContextForPath(
    getDocumentPath(document),
    context,
    detectSlots,
    cleanCache,
    getDocumentWorkspaceRoot(document),
  )
  const analyzeDocumentSlots = async (document: vscode.TextDocument, packageContext: Awaited<ReturnType<typeof ensureContextForPath>>) => {
    if (!getIsShowSlots() || !packageContext?.uiCompletions || isSkip(document))
      return
    const identity = { packagePath: packageContext.pkgPath, contextGeneration: packageContext.generation, contextRevision: packageContext.revision }
    const cached = getDocumentSlotAnalysis(document.uri)
    if (cached?.documentVersion === document.version && cached.packagePath === identity.packagePath) {
      if (cached.contextGeneration > identity.contextGeneration || (cached.contextGeneration === identity.contextGeneration && cached.contextRevision > identity.contextRevision))
        return
      if (cached.contextGeneration === identity.contextGeneration && cached.contextRevision === identity.contextRevision)
        return
    }
    if (cached)
      clearDocumentAnalysis(document.uri)
    const code = document.getText()
    await detectSlots(document, packageContext.uiCompletions, getUiDeps(code), packageContext.optionsComponents.prefix, identity)
  }

  context.subscriptions.push(onPackageContextsInvalidated(() => clearDocumentAnalysis()))
  context.subscriptions.push(onPackageContextUpdated((packageContext) => {
    for (const editor of vscode.window.visibleTextEditors) {
      const documentPath = getDocumentPath(editor.document)
      void resolvePackagePathForDocument(documentPath).then((nearestPackagePath) => {
        if (nearestPackagePath !== packageContext.pkgPath)
          return
        const latestContext = getContextForPackagePath(nearestPackagePath)
        if (latestContext)
          return analyzeDocumentSlots(editor.document, latestContext)
      }).catch(error => logger.error(String(error)))
    }
  }))

  context.subscriptions.push(registerCommand('common-intellisense.cleanCache', async () => {
    clearFetchCaches()
    invalidateContexts()
    clearDocumentAnalysis()
    await awaitCacheWrites()
    try {
      await fsp.rm(localCacheUri, { force: true })
    }
    catch {}
    const editor = vscode.window.activeTextEditor
    if (editor && !isSkip(editor.document))
      await ensureDocumentContext(editor.document)
  }))
  context.subscriptions.push(registerCodeLensProviderFn())

  context.subscriptions.push(addEventListener('activeText-change', (editor?: vscode.TextEditor) => {
    if (!editor || editor.document.languageId === 'Log')
      return

    if (isSkip(editor.document))
      return
    // 找到当前活动的编辑器
    const visibleEditors = vscode.window.visibleTextEditors
    const currentEditor = visibleEditors.find(e => e === editor)
    if (currentEditor) {
      void ensureDocumentContext(editor.document)
        .then(packageContext => analyzeDocumentSlots(editor.document, packageContext))
        .catch(error => logger.error(String(error)))
    }
  }))

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    const key = document.uri.toString()
    const timer = slotTimers.get(key)
    if (timer)
      clearTimeout(timer)
    slotTimers.delete(key)
    clearDocumentAnalysis(document.uri)
    clearLocalDocumentAnalysis(document.uri)
  }))

  context.subscriptions.push(registerCommand('intellisense.copyDemo', (demo) => {
    setCopyText(demo)
    message.info('copy successfully')
  }))

  context.subscriptions.push(registerCommand('common-intellisense.pickUI', async () => {
    const editor = vscode.window.activeTextEditor
    const packageContext = editor ? await ensureDocumentContext(editor.document) : undefined
    const currentPkgUiNames = packageContext?.currentPkgUiNames ? [...packageContext.currentPkgUiNames] : undefined
    if (packageContext && currentPkgUiNames?.length) {
      if (currentPkgUiNames.some(i => i.includes('bitsUi'))) {
        currentPkgUiNames.filter(i => i.startsWith('bitsUi')).map(i => i.replace('bitsUi', 'shadcnSvelte')).forEach((i) => {
          if (!currentPkgUiNames!.includes(i))
            currentPkgUiNames!.push(i)
        })
      }

      const rawCfg = getConfiguration('common-intellisense.ui') as any
      const selectedForPackage = getSelectedUIs(packageContext.pkgPath) || []
      const options: ({ label: string, picked?: boolean })[] = currentPkgUiNames.map((label: string) => selectedForPackage.includes(label) ? { label, picked: true } : { label })

      const data = await createSelect(options, {
        canSelectMany: true,
        placeHolder: isZh ? '请指定你需要提示的 UI 库' : 'Please specify the UI library you need to prompt.',
        title: 'common intellisense',
      })
      if (!data)
        return

      // Save the selection for the active editor's package only.
      const pkgPath = packageContext.pkgPath
      let newCfg: any
      if (pkgPath) {
        if (rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg))
          newCfg = { ...rawCfg, [pkgPath]: data }
        else
          newCfg = { [pkgPath]: data }
      }
      else {
        newCfg = data
      }
      setConfiguration('common-intellisense.ui', newCfg)
    }
    else {
      message.error(isZh
        ? '当前项目中并没有安装 common intellisense 支持的 UI 库'
        : 'There is no UI library supported by common intelligence in the current project.')
    }
  }))

  context.subscriptions.push(addEventListener('config-change', (e) => {
    const keys = ['ui', 'prefix', 'alias', 'exclude', 'remoteUris', 'remoteNpmUris', 'localUris', 'trustedHosts', 'allowLegacyAdapters', 'showSlots', 'translate']
    if (!keys.some(key => e.affectsConfiguration(`common-intellisense.${key}`)))
      return
    clearFetchCaches()
    invalidateContexts()
    clearDocumentAnalysis()
    documentAnalysisCache.clear()
    const editor = vscode.window.activeTextEditor
    if (editor && !isSkip(editor.document))
      void ensureDocumentContext(editor.document).catch(error => logger.error(`Failed to reload context after configuration change: ${String(error)}`))
  }))

  context.subscriptions.push(registerCommand('common-intellisense.import', async (params, _loc, _lineOffset) => {
    if (!params)
      return
    const { data, lib, prefix = '', dynamicLib, importWay = 'specifier' } = params
    const editor = getActiveTextEditor()
    if (!editor)
      return
    const code = editor.document.getText()
    const name = data.name.split('.')[0]
    const from = resolveImportSource(data.from, dynamicLib, lib, name, value => value.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''))
    const deps = [...getSuggestedImportNames(data.suggestions, prefix), name]
    const edits = createImportEdits(code, from, deps, importWay, editor.document.languageId === 'vue')
    if (!edits.length)
      return
    await updateText((edit) => {
      for (const item of [...edits].sort((a, b) => b.start - a.start)) {
        const start = getPosition(item.start, code).position
        const end = getPosition(item.end, code).position
        if (item.start === item.end)
          edit.insert(start, item.text)
        else
          edit.replace(createRange(start, end), item.text)
      }
    })
  }))

  // 监听pkg变化
  context.subscriptions.push(registerCommand('common-intellisense.slots', async (child, name, offset, detail) => {
    if (!getIsShowSlots())
      return
    const editor = vscode.window.activeTextEditor
    if (!editor)
      return
    const packageContext = getContextForDocumentPath(getDocumentPath(editor.document))
      || await ensureDocumentContext(editor.document)
    if (!packageContext?.uiCompletions)
      return
    if (!child) {
      const code = editor.document.getText()
      await detectSlots(editor.document, packageContext.uiCompletions, getUiDeps(code), packageContext.optionsComponents.prefix, { packagePath: packageContext.pkgPath, contextGeneration: packageContext.generation, contextRevision: packageContext.revision })
      return
    }
    if (!child.children)
      return

    let lastChild = [...child.children].reverse().find((c: any) => c.type !== 2)
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
        await insertText(`\n<template ${slotName}></template>`, getPosition(pos.offset + offset).position)
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

  context.subscriptions.push({ dispose() {
    for (const timer of slotTimers.values())
      clearTimeout(timer)
    slotTimers.clear()
  } })
  context.subscriptions.push(addEventListener('text-change', ({ contentChanges, document }) => {
    if (!getIsShowSlots() || contentChanges.length === 0 || document.languageId === 'Log' || isSkip(document))
      return
    const key = document.uri.toString()
    clearDocumentAnalysis(document.uri)
    const previous = slotTimers.get(key)
    if (previous)
      clearTimeout(previous)
    slotTimers.set(key, setTimeout(() => {
      slotTimers.delete(key)
      const analyze = async () => {
        if (document.isClosed)
          return
        const packageContext = await ensureDocumentContext(document)
        if (document.isClosed || !packageContext?.uiCompletions)
          return
        const code = document.getText()
        if (document.isClosed)
          return
        await detectSlots(document, packageContext.uiCompletions, getUiDeps(code), packageContext.optionsComponents.prefix, { packagePath: packageContext.pkgPath, contextGeneration: packageContext.generation, contextRevision: packageContext.revision })
      }
      void analyze().catch(error => logger.error(`Slot analysis failed: ${String(error)}`))
    }, 200))
  }))

  context.subscriptions.push(registerCompletionItemProvider(filter, async (document, position) => {
    if (isSkip(document))
      return
    const packageContext = await ensureDocumentContext(document)
    if (!packageContext?.uiCompletions)
      return
    const optionsComponents = packageContext.optionsComponents
    const componentsPrefix = optionsComponents.prefix
    let UiCompletions = packageContext.uiCompletions
    const alias = getAlias(packageContext.pkgPath) || {}
    const lineText = document.lineAt(position.line).text
    const p = position
    const preText = lineText.slice(0, position.character)
    let completionsCallback: SubCompletionItem[] | undefined
    let eventCallback: SubCompletionItem[] | undefined
    const activeText = getEffectWord(preText)
    const documentCode = document.getText()
    const result = parser(documentCode, p, { languageId: document.languageId, uri: document.uri.toString(), offset: getDocumentOffset(document, p, documentCode) })
    if (!result)
      return
    if (activeText === ':' && result.type === 'text')
      return

    const isVineDocument = document.uri.fsPath.endsWith('.vine.ts')
    const isVue = (document.languageId === 'vue' && result.template) || isVineDocument
    const renderContext = getCompletionRenderContext(document)
    const analysis = getDocumentAnalysis(document)
    const deps = isVue ? analysis.getImportDeps() : {}
    const uiDeps = analysis.getUiDeps()
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

    if (
      (result.parent && result.tag === 'template')
      || result.type === 'slot' || result.isSlot || result.type === 'slots' || (typeof result.propName === 'string' && result.propName.startsWith('#'))
    ) {
      const parentTag = result.parent?.tag || result.parent?.name || result.parentTag
      if (parentTag) {
        let matchedComponent = findPrefixedComponent(parentTag, componentsPrefix, UiCompletions)
        if (!matchedComponent) {
          matchedComponent = UiCompletions[fixedTagName(parentTag)]
        }
        const slots = matchedComponent?.slots
        if (slots)
          return slots
      }
    }

    let matchedComponent = result.tag ? findPrefixedComponent(result.tag, componentsPrefix, UiCompletions) : null
    if (result.tag && !matchedComponent)
      matchedComponent = UiCompletions[fixedTagName(result.tag)]
    const matchedSource = result.tag ? uiDeps?.[fixedTagName(result.tag)] : undefined
    if (matchedComponent && matchedSource && matchedComponent.lib !== matchedSource)
      matchedComponent = await findDynamicComponent(fixedTagName(result.tag), {}, UiCompletions, componentsPrefix, matchedSource)
    if (matchedComponent) {
      if (result.propName === 'icon')
        return matchedComponent.icons
      const existingPropsSet = new Set(getExistingPropNames(result, lineText))
      const existingProps = existingPropsSet.size ? existingPropsSet : null
      if (result.isEvent) {
        const events = matchedComponent.events?.[0]?.(renderContext) || []
        return existingProps ? filterExistingCompletions(events, existingProps) : events
      }
      // slot suggestions for all slot-related scenarios
      if (matchedComponent.slots && (result.type === 'slots' || result.type === 'slot' || result.isSlot || (typeof result.propName === 'string' && result.propName.startsWith('#'))))
        return matchedComponent.slots
      const completions = matchedComponent.completions?.[0]?.(renderContext) || []
      return existingProps ? filterExistingCompletions(completions, existingProps) : completions
    }

    if (UiCompletions && result?.type === 'props' && !result.isDynamicFlag) {
      if (result.propName === 'icon')
        return UiCompletions.icons
      const name = fixedTagName(result.tag)
      const propName = result.propName
      const from = uiDeps?.[name]
      const cacheMap = packageContext.cacheMap
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
      let target = await findDynamicComponent(name, deps, UiCompletions, componentsPrefix, from, getDocumentPath(document))
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
                documentation.appendMarkdown(`**🌟 ${i.name}** \n`)
                documentation.appendMarkdown(`- ${isZh ? '类型' : 'type'}: ${i.type}\n`)
                documentation.appendMarkdown(`- ${isZh ? '描述' : 'description'}: ${isZh ? i.description_zh : i.description}\n`)
                documentation.appendMarkdown(`- ${isZh ? '默认值' : 'default'}: ${i.default}\n`)
              })
            }

            const snippet = item.params?.length
              ? `:${item.name}="${JSON.stringify(item.params.reduce((acc, i) => {
                const key = i.name
                const type = i.type.toLocaleLowerCase()
                const value = i.default ?? (type === 'boolean' ? false : type === 'number' ? 0 : '')
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
      eventCallback = events[0](renderContext) || []
      completionsCallback = [...completions[0](renderContext), ...(isVue ? [] : eventCallback), ...directivesCompletions]

      const hasProps = new Set(getExistingPropNames(result, lineText))
      const hasProp = (item: any) => {
        const key = normalizePropName(item?.params?.[1] ?? (typeof item?.label === 'string' ? item.label : ''))
        return key ? hasProps.has(key) : false
      }
      if (propName === 'on') {
        return eventCallback.filter((item: any) => !hasProp(item))
      }
      else if (propName) {
        const r: any[] = []
        if (isValue) {
          completionsCallback.filter((item: any) => hasProp(item)).filter((item: any) => {
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
          r.push(...(completionsCallback ?? []).filter((item: any) => !hasProp(item)).map((item: any) => createCompletionItem(({
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
            : eventCallback.filter((item: any) => !hasProp(item))
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
      else if (hasProps.size) {
        return (completionsCallback ?? []).filter((item: any) => !hasProp(item))
      }
      else {
        return completionsCallback
      }
    }
    else if (!result.isInTemplate || !optionsComponents) {
      return
    }
    else if (isValue && (isVue || !result.isDynamicFlag)) {
      return
    }

    const prefix = lineText.trim().split(' ').slice(-1)[0]
    if (!prefix)
      return

    if (prefix.toLowerCase() === prefix
      ? optionsComponents.prefix.some((reg: string) => !reg || prefix.startsWith(reg) || reg.startsWith(prefix))
      : true) {
      const parent = result.parent
      const data = await Promise.all(optionsComponents.data.map(c => c(parent, renderContext)).flat())
      if (parent) {
        const parentTag = parent.tag || parent.name
        if (UiCompletions) {
          const suggestions = UiCompletions[fixedTagName(parentTag)]?.suggestions
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

  const openTrustedDocumentation = (args: any) => {
    const url = getTrustedDocumentationUrl(args?.link)
    if (url)
      openExternalUrl(url)
  }
  context.subscriptions.push(registerCommand('intellisense.openDocument', openTrustedDocumentation))
  context.subscriptions.push(registerCommand('intellisense.openDocumentExternal', openTrustedDocumentation))

  context.subscriptions.push(vscode.languages.registerHoverProvider(LANS, {
    async provideHover(document, position) {
      if (isSkip(document))
        return
      const packageContext = await ensureDocumentContext(document)
      if (!packageContext?.uiCompletions)
        return
      const optionsComponents = packageContext.optionsComponents
      const componentsPrefix = optionsComponents.prefix
      const renderContext = getCompletionRenderContext(document)
      let UiCompletions = packageContext.uiCompletions
      const alias = getAlias(packageContext.pkgPath) || {}
      const currentFileUrl = getDocumentPath(document)
      if (isExcluded(currentFileUrl))
        return

      const range = document.getWordRangeAtPosition(position)
      if (!range)
        return

      let word = document.getText(range)

      const lineText = document.lineAt(position.line).text
      if (!lineText)
        return

      const analysis = getDocumentAnalysis(document)
      const code = analysis.code
      const uiDeps = analysis.getUiDeps()
      let parsedResult: any
      let parsedResolved = false
      const getParsedResult = () => {
        if (!parsedResolved) {
          parsedResolved = true
          parsedResult = parser(code, position as any, { languageId: document.languageId, uri: document.uri.toString(), offset: getDocumentOffset(document, position as any, code) })
        }
        return parsedResult
      }
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
        const result = getParsedResult()
        if (!result)
          return
        if (result.type === 'tag') {
          if (!word)
            return createHover('')
          const tag = fixedTagName(result.tag)
          const target = await findDynamicComponent(tag, {}, UiCompletions, componentsPrefix, uiDeps?.[tag])
          if (target?.tableDocument)
            return createHover(target.tableDocument)

          const fixedWord = fixedTagName(word)
          const direct = UiCompletions[fixedWord]
            || findPrefixedComponent(fixedWord, componentsPrefix, UiCompletions)
            || await findDynamicComponent(fixedWord, {}, UiCompletions, componentsPrefix, uiDeps?.[fixedWord])
          if (direct?.tableDocument)
            return createHover(direct.tableDocument)
        }
        else if (result.type === 'props' && result.tag === 'template') {
          const parentTag = result.parent.tag
          if (!parentTag)
            return

          const name = fixedTagName(parentTag)
          const slotName = result.props.find((item: any) => item.name === 'slot')?.arg?.content

          if (!slotName)
            return

          const from = uiDeps?.[name]
          const cacheMap = packageContext.cacheMap

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
          md.appendMarkdown(`**${target.lib} [${targetSlot.name}]**\n`)
          md.appendMarkdown(`- ${isZh ? '说明' : 'description'}: ${isZh ? targetSlot.description_zh : targetSlot.description}\n`)
          md.appendMarkdown(`**${isZh ? '插槽 props' : 'slotProps'}:** \n`)
          const typeString = `interface SlotProps ${params}`
          md.appendCodeblock(prettierType(typeString), 'typescript')
          return createHover(md)
        }
        else if (!result.propName) {
          return
        }
        // 这个实现有些问题,要从底层去修改 propName 上的信息,才能拿到准确的数据
        const findBind = () => result.props.find((p: any) => p.name === 'bind')
        const findOn = () => result.props.find((p: any) => p.name === 'on')
        const propName = result.propName === true ? result.props[0].name === 'on' ? findOn()?.arg.content : findBind()?.arg.content : result.propName

        if (typeof propName !== 'string')
          return

        if (['class', 'className', 'style', 'id'].includes(propName))
          return
        const tag = fixedTagName(result.tag)
        const r = UiCompletions[tag] || await findDynamicComponent(tag, {}, UiCompletions, componentsPrefix, uiDeps?.[tag])
        if (!r)
          return
        const completions = result.isEvent ? r.events[0]?.(renderContext) : r.completions[0]?.(renderContext)
        if (!completions)
          return

        const detail = getHoverAttribute(completions, propName)
        if (!detail)
          return
        return createHover(`**Details** \n\n${detail}`)
      }
      // todo: 优化这里的条件,在 react 中, 也可以减少更多的处理步骤
      if (document.languageId === 'vue') {
        const r = getParsedResult()
        if (r) {
          if (!r.template)
            return
          if (word.includes('.value.') && r.type === 'script' && r.refs.length) {
            const refsMap = r.refsMap || {}
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
                  content = stripLeadingMarkdownTitle(content)
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
      else if (document.uri.fsPath.endsWith('.vine.ts')) {
        const r = getParsedResult()
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
                  content = stripLeadingMarkdownTitle(content)
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
      else if (document.languageId.includes('react')) {
        if (word.includes('.current.')) {
          const r = getParsedResult()
          if (!r)
            return
          const index = word.indexOf('.current.')
          const key = word.slice(0, index)
          const refName = r.refsMap?.[key]
          if (!refName)
            return

          if (lineText.slice(range.start.character, range.end.character) === 'current') {
            // hover .value.区域 提示所有方法
            const groupMd = createMarkdownString()
              ;[...UiCompletions[refName].methods, ...UiCompletions[refName].exposed].forEach((m, i) => {
              let content = typeof m.documentation === 'string' ? m.documentation : m.documentation?.value || ''
              if (i !== 0) {
                content = stripLeadingMarkdownTitle(content)
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

      const matchedComponent = findPrefixedComponent(word, componentsPrefix, UiCompletions)
      if (matchedComponent && matchedComponent.tableDocument) {
        return createHover(matchedComponent.tableDocument)
      }
      if (UiCompletions[word] && UiCompletions[word].tableDocument) {
        return createHover(UiCompletions[word].tableDocument)
      }
      const target = await findDynamicComponent(word, {}, UiCompletions, optionsComponents.prefix, uiDeps?.[word])
      if (target?.tableDocument)
        return createHover(target.tableDocument)

      if (document.languageId === 'vue') {
        const parsed = getParsedResult()
        if (parsed?.type === 'tag' && parsed.tag) {
          const tag = fixedTagName(parsed.tag)
          const fallbackTarget = await findDynamicComponent(tag, {}, UiCompletions, componentsPrefix, uiDeps?.[tag])
          if (fallbackTarget?.tableDocument)
            return createHover(fallbackTarget.tableDocument)
        }
      }
    },
  }))

  void Promise.resolve(getLocalCache).then(async () => {
    if (!initialEditor || isSkip(initialEditor.document))
      return
    const packageContext = await ensureDocumentContext(initialEditor.document)
    await analyzeDocumentSlots(initialEditor.document, packageContext)
  }).catch(error => logger.error(`Initial context preload failed: ${String(error)}`))
}

export function deactivate() {
  clearDocumentAnalysis()
  documentAnalysisCache.clear()
  clearFetchCaches()
  deactivateUICache()
}

function getTrustedDocumentationUrl(value: unknown) {
  if (typeof value !== 'string')
    return
  try {
    const url = new URL(value)
    if (url.protocol === 'https:')
      return url.toString()
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))
      return url.toString()
  }
  catch {}
}

function stripLeadingMarkdownTitle(content: string) {
  return content.replace(/^(?:##[^\n]*|\*\*[^\n]+?\*\*)\n*/, '')
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

function normalizePropName(name: any) {
  if (!name || typeof name !== 'string')
    return ''
  let value = name
  if (value.startsWith('@'))
    value = value.slice(1)
  if (value.startsWith(':'))
    value = value.slice(1)
  if (value.startsWith('v-on:'))
    value = value.slice('v-on:'.length)
  if (value.startsWith('v-bind:'))
    value = value.slice('v-bind:'.length)
  return toCamel(value)
}

function getExistingPropNames(result: any, lineText?: string) {
  const fromAst = result?.props
    ? result.props.map((item: any) => {
        if (item?.type === 'JSXAttribute' && item.name?.name)
          return item.name.name
        if (item?.type === 'JSXSpreadAttribute')
          return false
        if (item?.type === 'EventHandler' && item.name?.name)
          return item.name.name

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
  const fromLine = extractPropsFromLine(result, lineText)
  return [...fromAst, ...fromLine].map(normalizePropName).filter(Boolean)
}

function extractPropsFromLine(result: any, lineText?: string) {
  if (!lineText || !result?.tag)
    return []
  const tagIndex = lineText.indexOf(`<${result.tag}`)
  if (tagIndex < 0)
    return []
  const afterTag = lineText.slice(tagIndex + result.tag.length + 1)
  const attrText = (afterTag.split('>')[0] || '').trim()
  if (!attrText)
    return []
  const names: string[] = []
  const regex = /(?:^|\s)(@[\w:-]+|v-on:[\w:-]+|v-bind:[\w:-]+|:[\w-]+|[\w-]+)(?==)/g
  for (const match of attrText.matchAll(regex)) {
    const raw = match[1]
    if (raw && raw !== '/' && raw !== result.tag)
      names.push(raw)
  }
  return names
}

function filterExistingCompletions(items: SubCompletionItem[] | undefined, existing: Set<string>) {
  if (!items?.length || !existing.size)
    return items || []
  return items.filter((item: any) => {
    const label = typeof item?.label === 'string'
      ? item.label
      : item?.label?.label || ''
    const raw = item?.params?.[1] ?? label
    const key = normalizePropName(raw)
    return !key || !existing.has(key)
  })
}

function getHoverAttribute(attributeList: any[], attr: string) {
  return attributeList.filter(a =>
    toCamel(a?.params?.[1]?.replace('v-model:', '') || '') === toCamel(attr),
  ).map(i => `- ${i.details}`).join('\n\n')
}
