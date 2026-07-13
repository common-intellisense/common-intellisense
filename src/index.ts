import type { CompletionRenderContext, Directives, PropsConfig, SubCompletionItem } from './ui/utils'
import fsp from 'node:fs/promises'
import { createFilter } from '@rollup/pluginutils'
import { addEventListener, createCompletionItem, createHover, createMarkdownString, createSelect, getConfiguration, getLocale, message, openExternalUrl, registerCommand, registerCompletionItemProvider, setConfiguration, setCopyText } from '@vscode-use/utils'
import * as vscode from 'vscode'
import { nameMap } from './constants'
import { awaitCacheWrites, clearFetchCaches, configureCacheStorage, getLocalCache, localCacheUri, normalizeHostname } from './services/fetch'
import type { ComponentSourceScope } from './services/component-resolver'
import { findComponentSourceScope, isLocalModuleSource, resolveImportedTag, sourceScopeAccepts } from './services/component-resolver'
import { createImportEdits, getSuggestedImportNames, resolveImportSource } from './services/imports'
import { getNodeOffsetRange } from './services/node-range'
import { isNativeTag } from './services/native-tags'
import { prettierType } from './prettier-type'
import { findPrefixedComponent, generateScriptNames, toCamel } from './ui/utils'
import { deactivateUICache, ensureContextForPath, getContextForDocumentPath, getContextForPackagePath, getSourceScope, invalidateContexts, invalidateDocumentPackageMappingsForManifest, invalidatePackageContext, logger, onPackageContextsInvalidated, onPackageContextUpdated, releaseDocumentContext, resolvePackagePathForDocument } from './ui/ui-find'
import { fixedTagName, getAlias, getIsShowSlots, getSelectedUIs, getUiDeps, getUiImportedName } from './ui/ui-utils'
import { clearDocumentAnalysesForPackages, clearDocumentAnalysis, detectSlots, findDynamicComponent, getDocumentSlotAnalysis, getImportDeps, parser, registerCodeLensProviderFn, resolveLocalWrappedComponent } from './parser'

const filter = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte']
interface DocumentAnalysisCacheEntry {
  uri: string
  version: number
  code: string
  uiDepsByBlock: Map<number, Record<string, string>>
  importDepsByBlock: Map<number, Record<string, string>>
}
const documentAnalysisCache = new Map<string, DocumentAnalysisCacheEntry>()
const maxDocumentAnalysisEntries = 10
let excludeFilter = createFilter([])

function refreshExcludeFilter() {
  excludeFilter = createFilter(getConfiguration('common-intellisense.exclude') || [])
}

export function normalizeScopedSource(from: string | undefined, alias: Record<string, string>, sourceScopes?: Map<string, ComponentSourceScope>): string | undefined {
  if (!from)
    return
  if (sourceScopes) {
    const scope = getSourceScope({ sourceScopes }, from)
    if (scope)
      return scope.exactLib || scope.lib
  }
  const packageName = from.startsWith('@') ? from.split('/').slice(0, 2).join('/') : from.split('/')[0]
  const configured = alias[from] || alias[packageName] || nameMap[from] || nameMap[packageName] || packageName
  return configured.replace(/\d+$/, '')
}

export function selectScopedCompletions(current: PropsConfig, cacheMap: Map<string, any>, from: string | undefined, alias: Record<string, string>, sourceScopes?: Map<string, ComponentSourceScope>): PropsConfig {
  if (!from)
    return current
  const explicitScope = sourceScopes ? getSourceScope({ sourceScopes }, from) : undefined
  if (explicitScope) {
    const scoped = cacheMap.get(explicitScope.key)
    return scoped && typeof scoped === 'object' && !Array.isArray(scoped) ? scoped as PropsConfig : current
  }
  const fixedFrom = normalizeScopedSource(from, alias, sourceScopes) || from
  const adapterName = toCamel(fixedFrom)
  const targetKey = Array.from(cacheMap.keys()).find(key => typeof key === 'string' && key.startsWith(adapterName) && /^\d+$/.test(key.slice(adapterName.length)))
  const targetValue = targetKey ? cacheMap.get(targetKey) : undefined
  return targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue) ? targetValue as PropsConfig : current
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, match => `\\${match}`)
}

export function hasComponentTag(code: string, name: string, prefix = '') {
  const rootName = name.split('.')[0]
  const candidates = new Set([name, rootName])
  if (prefix) {
    candidates.add(`${prefix}${rootName}`)
    candidates.add(`${prefix[0]?.toUpperCase() || ''}${prefix.slice(1)}${rootName}`)
    candidates.add(`${prefix}-${rootName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}`)
  }
  return [...candidates].some(candidate => new RegExp(`<\\s*${escapeRegExp(candidate)}(?=[\\s/>.])`).test(code))
}

export function getRefVariableNames(result: any): string[] {
  const names: unknown[] = Array.isArray(result?.refs)
    ? result.refs.map((ref: string | [string, string]) => Array.isArray(ref) ? ref[0] : ref)
    : Object.keys(result?.refsMap || {})
  return [...new Set(names.filter((name: unknown): name is string => typeof name === 'string' && !!name))]
}

export function getRefMembers(completions: PropsConfig, refName: string | undefined): any[] | undefined {
  if (!refName)
    return
  const component = completions[refName]
  if (!component)
    return
  return [...(component.methods || []), ...(component.exposed || [])]
}

export async function resolveImportedComponent(rawTag: string | undefined, uiDeps: Record<string, string>, completions: PropsConfig, cacheMap: Map<string, any>, alias: Record<string, string>, prefixes: string[], sourceScopes?: Map<string, ComponentSourceScope>, localDeps: Record<string, string> = uiDeps, currentDocumentPath?: string, workspaceRoot?: string) {
  if (!rawTag)
    return {}
  const importedTag = resolveImportedTag(rawTag, uiDeps)
  const resolvedSource = importedTag.source || localDeps[importedTag.localRoot]
  if (isLocalModuleSource(resolvedSource)) {
    const component = await resolveLocalWrappedComponent(
      resolvedSource,
      completions,
      prefixes,
      currentDocumentPath,
      workspaceRoot,
      source => selectScopedCompletions(completions, cacheMap, source, alias, sourceScopes),
    )
    return { component, source: resolvedSource, scoped: completions }
  }
  const scoped = resolvedSource
    ? selectScopedCompletions(completions, cacheMap, resolvedSource, alias, sourceScopes)
    : completions
  const scope = findComponentSourceScope(sourceScopes, resolvedSource)
  const normalizedSource = scope?.exactLib || scope?.lib || (!scope ? normalizeScopedSource(resolvedSource, alias, sourceScopes) : undefined)
  for (const candidate of importedTag.candidates) {
    const component = await findDynamicComponent(candidate, {}, scoped, prefixes, normalizedSource)
    if (component && sourceScopeAccepts(scope, component.lib))
      return { component, source: resolvedSource, scoped }
  }
  return { source: resolvedSource, scoped }
}

export async function resolveRefMembers(localName: string | undefined, uiDeps: Record<string, string>, completions: PropsConfig, cacheMap: Map<string, any>, alias: Record<string, string>, prefixes: string[], sourceScopes?: Map<string, ComponentSourceScope>, localDeps: Record<string, string> = uiDeps, currentDocumentPath?: string, workspaceRoot?: string) {
  const { component } = await resolveImportedComponent(localName, uiDeps, completions, cacheMap, alias, prefixes, sourceScopes, localDeps, currentDocumentPath, workspaceRoot)
  return component ? [...(component.methods || []), ...(component.exposed || [])] : undefined
}

export function getDocumentAnalysis(document: vscode.TextDocument, code?: string) {
  const uri = document.uri.toString()
  let entry = documentAnalysisCache.get(uri)
  if (!entry || entry.version !== document.version) {
    entry = {
      uri,
      version: document.version,
      code: code ?? document.getText(),
      uiDepsByBlock: new Map(),
      importDepsByBlock: new Map(),
    }
    documentAnalysisCache.delete(uri)
    documentAnalysisCache.set(uri, entry)
    while (documentAnalysisCache.size > maxDocumentAnalysisEntries)
      documentAnalysisCache.delete(documentAnalysisCache.keys().next().value!)
  }
  else {
    // Touch the entry so the cache is an actual URI-level LRU.
    documentAnalysisCache.delete(uri)
    documentAnalysisCache.set(uri, entry)
  }
  return {
    get code() {
      return entry!.code
    },
    getUiDeps(activeOffset?: number) {
      const key = activeOffset ?? -1
      if (!entry!.uiDepsByBlock.has(key))
        entry!.uiDepsByBlock.set(key, getUiDeps(entry!.code, { languageId: document.languageId, uri, activeOffset }) || {})
      return entry!.uiDepsByBlock.get(key)!
    },
    getImportDeps(activeOffset?: number) {
      const key = activeOffset ?? -1
      if (!entry!.importDepsByBlock.has(key))
        entry!.importDepsByBlock.set(key, getImportDeps(entry!.code, typeof activeOffset === 'number' ? { activeOffset } : undefined) || {})
      return entry!.importDepsByBlock.get(key)!
    },
  }
}

export function clearLocalDocumentAnalysis(uri: string | vscode.Uri) {
  documentAnalysisCache.delete(typeof uri === 'string' ? uri : uri.toString())
}

export function getDocumentAnalysisCacheSize() {
  return documentAnalysisCache.size
}

function isExcluded(filePath: string) {
  return excludeFilter(filePath)
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

function getCompletionRenderContext(document: vscode.TextDocument, result?: any): CompletionRenderContext {
  const isVineDocument = document.uri.fsPath.endsWith('.vine.ts')
  const hostFramework = isVineDocument ? 'vine' : result?.hostFramework || (document.languageId === 'vue' ? 'vue' : document.languageId === 'svelte' ? 'svelte' : 'react')
  const syntax = result?.syntax === 'jsx' || ['javascriptreact', 'typescriptreact'].includes(document.languageId) ? 'jsx' : 'template'
  return {
    languageId: document.languageId,
    hostFramework,
    syntax,
    framework: syntax === 'jsx' ? 'react' : hostFramework,
    uri: document.uri.toString(),
    version: document.version,
  }
}
// todo: 补充类型
// todo: 补充example
export async function activate(context: vscode.ExtensionContext) {
  refreshExcludeFilter()
  configureCacheStorage(context.globalStorageUri)
  // todo: createWebviewPanel
  // createWebviewPanel(context)
  logger.info('common-intellisense activate!')
  logger.info('🌟 please help star this project: https://github.com/common-intellisense/common-intellisense')
  const isZh = getLocale().includes('zh')
  const LANS = ['javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'solid', 'swan', 'react', 'js', 'ts', 'tsx', 'jsx']
  const initialEditor = vscode.window.activeTextEditor
  const slotTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const packageManifestWatcher = vscode.workspace.createFileSystemWatcher?.('**/package.json')
  if (packageManifestWatcher) {
    const invalidateManifest = (uri: vscode.Uri) => {
      invalidateDocumentPackageMappingsForManifest(uri.fsPath)
      invalidatePackageContext(uri.fsPath)
    }
    context.subscriptions.push(
      packageManifestWatcher,
      packageManifestWatcher.onDidCreate(invalidateManifest),
      packageManifestWatcher.onDidDelete(invalidateManifest),
    )
  }
  const ensureDocumentContext = (document: vscode.TextDocument, cleanCache = false) => ensureContextForPath(
    getDocumentPath(document),
    context,
    detectSlots,
    cleanCache,
    getDocumentWorkspaceRoot(document),
  )
  const analyzeDocumentSlots = async (document: vscode.TextDocument, packageContext: Awaited<ReturnType<typeof ensureContextForPath>>) => {
    if (document.isClosed || !getIsShowSlots() || !packageContext?.uiCompletions || isSkip(document))
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
    if (document.isClosed)
      return
    const analysis = getDocumentAnalysis(document, code)
    await detectSlots(document, packageContext.uiCompletions, analysis.getUiDeps(), packageContext.optionsComponents.prefix, identity, { cacheMap: packageContext.cacheMap, sourceScopes: packageContext.sourceScopes, localDeps: analysis.getImportDeps(), currentDocumentPath: getDocumentPath(document), workspaceRoot: packageContext.workspaceRoot })
  }
  const rebuildVisibleDocumentContexts = async (existingOnly = false) => {
    await Promise.all(vscode.window.visibleTextEditors.map(async ({ document }) => {
      if (isSkip(document))
        return
      const packageContext = existingOnly
        ? getContextForDocumentPath(getDocumentPath(document))
        : await ensureDocumentContext(document)
      await analyzeDocumentSlots(document, packageContext)
    }))
  }

  context.subscriptions.push(onPackageContextsInvalidated(packagePaths => packagePaths?.length
    ? clearDocumentAnalysesForPackages(packagePaths)
    : clearDocumentAnalysis()))
  context.subscriptions.push(onPackageContextUpdated((packageContext) => {
    for (const editor of vscode.window.visibleTextEditors) {
      const documentPath = getDocumentPath(editor.document)
      void resolvePackagePathForDocument(documentPath).then((nearestPackagePath) => {
        if (editor.document.isClosed || !vscode.window.visibleTextEditors.includes(editor))
          return
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
    await rebuildVisibleDocumentContexts()
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
    releaseDocumentContext(getDocumentPath(document))
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
    const affects = (key: string) => e.affectsConfiguration(`common-intellisense.${key}`)
    if (affects('exclude'))
      refreshExcludeFilter()

    if (affects('showSlots')) {
      clearDocumentAnalysis()
      void rebuildVisibleDocumentContexts(true).catch(error => logger.error(`Failed to refresh slots after configuration change: ${String(error)}`))
    }

    const rebuildContexts = ['ui', 'prefix', 'alias', 'translate'].some(affects)
    const rebuildSources = ['remoteUris', 'remoteNpmUris', 'localUris', 'trustedHosts', 'allowLegacyAdapters'].some(affects)
    if (!rebuildContexts && !rebuildSources)
      return

    if (rebuildSources)
      clearFetchCaches()
    invalidateContexts()
    clearDocumentAnalysis()
    documentAnalysisCache.clear()
    void rebuildVisibleDocumentContexts().catch(error => logger.error(`Failed to reload contexts after configuration change: ${String(error)}`))
  }))

  context.subscriptions.push(registerCommand('common-intellisense.import', async (params, activeLoc) => {
    if (!params?.document?.uri || typeof params.document.version !== 'number')
      return
    const uri = vscode.Uri.parse(params.document.uri)
    const document = await vscode.workspace.openTextDocument(uri)
    // The completion list may be filtered for several keystrokes before the
    // selected snippet is applied. A version delta is therefore not a reliable
    // freshness check; only reject a document older than the captured request.
    if (document.version < params.document.version)
      return
    const { data, lib, prefix = '', dynamicLib, importWay = 'specifier' } = params
    if (typeof data?.name !== 'string' || !data.name.trim())
      return
    const code = document.getText()
    if (!hasComponentTag(code, data.name, prefix))
      return
    const name = data.name.split('.')[0]
    const from = resolveImportSource(data.from, dynamicLib, lib, name, value => value.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''))
    const deps = [...getSuggestedImportNames(data.suggestions, prefix, importWay), name]
    const importHost = document.languageId === 'vue' ? 'vue' : document.languageId === 'svelte' ? 'svelte' : 'script'
    const preferredOffset = typeof activeLoc?.start?.offset === 'number' ? activeLoc.start.offset : undefined
    const edits = createImportEdits(code, from, deps, importWay, importHost, {
      languageId: document.languageId,
      uri: document.uri.toString(),
      preferredOffset,
      registerVueComponent: typeof params.registerVueComponent === 'boolean' ? params.registerVueComponent : preferredOffset === undefined,
    })
    if (!edits.length)
      return
    const workspaceEdit = new vscode.WorkspaceEdit()
    for (const item of edits) {
      const start = document.positionAt(item.start)
      const end = document.positionAt(item.end)
      if (item.start === item.end)
        workspaceEdit.insert(uri, start, item.text)
      else
        workspaceEdit.replace(uri, new vscode.Range(start, end), item.text)
    }
    await vscode.workspace.applyEdit(workspaceEdit)
  }))

  // 监听pkg变化
  context.subscriptions.push(registerCommand('common-intellisense.slots', async (child, name, offset, detail, editIdentity) => {
    if (!getIsShowSlots() || !editIdentity?.uri || typeof editIdentity.version !== 'number')
      return
    const uri = vscode.Uri.parse(editIdentity.uri)
    const document = await vscode.workspace.openTextDocument(uri)
    const isVineDocument = document.uri.fsPath.endsWith('.vine.ts')
    if (document.languageId !== 'vue' && !isVineDocument)
      return
    if (document.version !== editIdentity.version)
      return
    const packageContext = getContextForDocumentPath(getDocumentPath(document))
      || await ensureDocumentContext(document)
    if (!packageContext?.uiCompletions
      || packageContext.pkgPath !== editIdentity.packagePath
      || packageContext.generation !== editIdentity.contextGeneration
      || packageContext.revision !== editIdentity.contextRevision) {
      return
    }
    if (!child?.children)
      return

    let lastChild = [...child.children].reverse().find((c: any) => c.type !== 2)
    let slotName = `#${name}`
    if (child.range)
      slotName = `v-slot:${name}`
    if (detail.params)
      slotName += '="slotProps"'
    const workspaceEdit = new vscode.WorkspaceEdit()
    const insertAt = (at: number, text: string) => workspaceEdit.insert(uri, document.positionAt(at), text)
    const replaceAt = (start: number, end: number, text: string) => workspaceEdit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text)

    if (lastChild) {
      if (isVineDocument && lastChild.codegenNode)
        lastChild = lastChild.codegenNode
      const lastRange = getNodeOffsetRange(lastChild, offset)
      if (!lastRange)
        return
      insertAt(lastRange.end, `
<template ${slotName}></template>`)
    }
    else {
      const childRange = getNodeOffsetRange(child, offset)
      if (!childRange)
        return
      const nodeText = document.getText().slice(childRange.start, childRange.end)
      const tag = child.tag || nodeText.match(/^<\s*([\w.$:-]+)/)?.[1]
      if (!tag)
        return
      const empty = ' '.repeat(Math.max((child.loc?.start?.column || 1) - 1, 0))
      const isSelfClosing = child.isSelfClosing || child.openingElement?.selfClosing
      if (isSelfClosing) {
        const closeIndex = nodeText.lastIndexOf('/>')
        if (closeIndex < 0)
          return
        const closeStart = childRange.start + closeIndex
        replaceAt(closeStart, childRange.end, `>
  <template ${slotName}></template>
</${tag}>`)
      }
      else {
        const closeIndex = nodeText.lastIndexOf('</')
        if (closeIndex < 0)
          return
        const sameLine = child.loc?.start?.line === child.loc?.end?.line
        insertAt(childRange.start + closeIndex, `${sameLine ? '\n' : empty}  <template ${slotName}></template>
`)
      }
    }
    await vscode.workspace.applyEdit(workspaceEdit)
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
        const analysis = getDocumentAnalysis(document, code)
        await detectSlots(document, packageContext.uiCompletions, analysis.getUiDeps(), packageContext.optionsComponents.prefix, { packagePath: packageContext.pkgPath, contextGeneration: packageContext.generation, contextRevision: packageContext.revision }, { cacheMap: packageContext.cacheMap, sourceScopes: packageContext.sourceScopes, localDeps: analysis.getImportDeps(), currentDocumentPath: getDocumentPath(document), workspaceRoot: packageContext.workspaceRoot })
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
    const UiCompletions = packageContext.uiCompletions
    const alias = getAlias(packageContext.pkgPath) || {}
    const lineText = document.lineAt(position.line).text
    const p = position
    const preText = lineText.slice(0, position.character)
    let completionsCallback: SubCompletionItem[] | undefined
    let eventCallback: SubCompletionItem[] | undefined
    const activeText = getEffectWord(preText)
    const completionAnalysis = getDocumentAnalysis(document)
    const documentCode = completionAnalysis.code
    const result = parser(documentCode, p, { languageId: document.languageId, uri: document.uri.toString(), offset: getDocumentOffset(document, p, documentCode) })
    if (!result)
      return
    if (activeText === ':' && result.type === 'text')
      return

    const isVineDocument = document.uri.fsPath.endsWith('.vine.ts')
    const isVue = document.languageId === 'vue' || result.hostFramework === 'vue' || isVineDocument
    const renderContext = { ...getCompletionRenderContext(document, result), parent: result.parent }
    const isTemplateSyntax = renderContext.syntax !== 'jsx'
    const activeScriptOffset = document.languageId === 'vue' && result.loc ? result.loc.start.offset : undefined
    const deps = isVue ? completionAnalysis.getImportDeps(activeScriptOffset) : {}
    const uiDeps = completionAnalysis.getUiDeps(document.languageId === 'vue' && result.loc ? result.loc.start.offset : undefined)
    const { character } = position
    const isPreEmpty = lineText[character - 1] === ' '
    const isValue = result.isValue

    const refVariableNames = getRefVariableNames(result)
    if (result.type === 'script' && (Object.keys(result.refsMap || {}).length || refVariableNames.length) && !isPreEmpty) {
      if (lineText?.slice(-1)[0] === '.') {
        for (const key in result.refsMap) {
          const value = result.refsMap[key]
          if (isVue && (lineText.endsWith(`.$refs.${key}.`) || lineText.endsWith(`${key}.value.`)))
            return resolveRefMembers(value, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
          else if (!isVue && lineText.endsWith(`${key}.current.`))
            return resolveRefMembers(value, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
        }
      }
      if (isVue && lineText.slice(character, character + 6) !== '.value' && /\.value\.?$/.test(lineText.slice(0, character)))
        return refVariableNames.map(refName => createCompletionItem({ content: refName, snippet: `${refName}.value`, documentation: `${refName}.value`, preselect: true, sortText: '0' }))

      if (!isVue && lineText.slice(character, character + 8) !== '.current' && /\.current\.?$/.test(lineText.slice(0, character)))
        return refVariableNames.map(refName => createCompletionItem({ content: refName, snippet: `${refName}.current`, documentation: `${refName}.current`, preselect: true, sortText: '0' }))

      return
    }

    if (
      (result.parent && result.tag === 'template')
      || result.type === 'slot' || result.isSlot || result.type === 'slots' || (typeof result.propName === 'string' && result.propName.startsWith('#'))
    ) {
      const parentTag = result.parent?.tag || result.parent?.name || result.parentTag
      if (parentTag) {
        const { component, source } = await resolveImportedComponent(parentTag, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
        const slots = component?.slots
        if (slots)
          return slots
        if (source)
          return
      }
    }

    const importedResolution = await resolveImportedComponent(result.tag, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
    let matchedComponent = importedResolution.component
    const matchedSource = importedResolution.source
    if (!matchedSource && isNativeTag(result.tag))
      return
    if (!matchedComponent && result.tag && !matchedSource)
      matchedComponent = findPrefixedComponent(result.tag, componentsPrefix, UiCompletions)
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
      const resolved = await resolveImportedComponent(result.tag, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
      const target = resolved.component || (!resolved.source ? await findDynamicComponent(name, deps, UiCompletions, componentsPrefix, undefined, getDocumentPath(document)) : undefined)

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
      const directivesCompletions = Array.isArray(directives)
        ? directives.filter((item: any) => typeof item?.name === 'string' && (!item.params || Array.isArray(item.params))).map((item: Directives[0]) => {
            const detail = isZh ? item.description_zh : item.description
            const content = `${item.name}  ${detail}`
            const documentation = createMarkdownString()
            if (item.documentation)
              documentation.appendMarkdown(item.documentation)
            else if (item.documentationType)
              documentation.appendCodeblock(item.documentationType, 'typescript')

            if (item.params?.length) {
              documentation.appendCodeblock('\n')
              item.params.filter((i: any) => typeof i?.name === 'string' && typeof i?.type === 'string').forEach((i: any) => {
                documentation.appendMarkdown(`**🌟 ${i.name}** \n`)
                documentation.appendMarkdown(`- ${isZh ? '类型' : 'type'}: ${i.type}\n`)
                documentation.appendMarkdown(`- ${isZh ? '描述' : 'description'}: ${isZh ? i.description_zh : i.description}\n`)
                documentation.appendMarkdown(`- ${isZh ? '默认值' : 'default'}: ${i.default}\n`)
              })
            }

            const snippet = item.params?.length
              ? `:${item.name}="${JSON.stringify(item.params.filter((i: any) => typeof i?.name === 'string' && typeof i?.type === 'string').reduce((acc: Record<string, any>, i: any) => {
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
      completionsCallback = [...completions[0](renderContext), ...(isTemplateSyntax ? [] : eventCallback), ...(isTemplateSyntax ? directivesCompletions : [])]

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
          if (result.isDynamicArgument)
            return
          const escapedPropName = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          completionsCallback.filter((item: any) => hasProp(item)).filter((item: any) => {
            const reg = propName === 'bind'
              ? /^:/
              : new RegExp(`^:?${escapedPropName}`)
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
        const events = isTemplateSyntax
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
    else if (isValue && (isTemplateSyntax || !result.isDynamicFlag)) {
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
      const UiCompletions = packageContext.uiCompletions
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
      const parsedResult: any = parser(code, position as any, { languageId: document.languageId, uri: document.uri.toString(), offset: getDocumentOffset(document, position as any, code) })
      const activeScriptOffset = document.languageId === 'vue' && typeof parsedResult?.loc?.start?.offset === 'number'
        ? parsedResult.loc.start.offset
        : undefined
      const uiDeps = analysis.getUiDeps(activeScriptOffset)
      const deps = analysis.getImportDeps(activeScriptOffset)
      const getParsedResult = () => parsedResult
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
          const resolved = await resolveImportedComponent(result.tag, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
          if (resolved.component?.tableDocument)
            return createHover(resolved.component.tableDocument)
          if (resolved.source)
            return

          const fixedWord = fixedTagName(word)
          const direct = UiCompletions[fixedWord]
            || findPrefixedComponent(fixedWord, componentsPrefix, UiCompletions)
            || await findDynamicComponent(fixedWord, {}, UiCompletions, componentsPrefix, normalizeScopedSource(uiDeps?.[fixedWord], alias, packageContext.sourceScopes))
          if (direct?.tableDocument)
            return createHover(direct.tableDocument)
        }
        else if (result.type === 'props' && result.tag === 'template') {
          const parentTag = result.parent.tag
          if (!parentTag)
            return

          const slotName = result.props.find((item: any) => item.name === 'slot')?.arg?.content

          if (!slotName)
            return

          const target = (await resolveImportedComponent(parentTag, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)).component
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
        const r = (await resolveImportedComponent(result.tag, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)).component
        if (!r)
          return
        const renderContext = getCompletionRenderContext(document, result)
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
            const refMembers = await resolveRefMembers(refName, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
            if (!refMembers)
              return

            if (lineText.slice(range.start.character, range.end.character) === 'value') {
              // hover .value.区域 提示所有方法
              const groupMd = createMarkdownString()
              refMembers.forEach((m, i) => {
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
            const target = refMembers.find(item => item.label === targetKey)

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
            const refMembers = await resolveRefMembers(refName, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
            if (!refMembers)
              return
            if (lineText.slice(range.start.character, range.end.character) === 'value') {
              // hover .value.区域 提示所有方法
              const groupMd = createMarkdownString()
              refMembers.forEach((m: any, i: number) => {
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
            const target = refMembers.find((item: any) => item.label === targetKey)

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
          const refMembers = await resolveRefMembers(refName, uiDeps, UiCompletions, packageContext.cacheMap, alias, componentsPrefix, packageContext.sourceScopes, deps, getDocumentPath(document), packageContext.workspaceRoot)
          if (!refMembers)
            return

          if (lineText.slice(range.start.character, range.end.character) === 'current') {
            // hover .value.区域 提示所有方法
            const groupMd = createMarkdownString()
            refMembers.forEach((m, i) => {
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
          const target = refMembers.find(item => item.label === targetKey)

          if (!target)
            return

          return target.hover
        }
      }

      const explicitSource = uiDeps?.[word]
      if (explicitSource) {
        const importedName = getUiImportedName(uiDeps, word)
        const scoped = selectScopedCompletions(UiCompletions, packageContext.cacheMap, explicitSource, alias, packageContext.sourceScopes)
        const target = await findDynamicComponent(importedName, {}, scoped, optionsComponents.prefix, normalizeScopedSource(explicitSource, alias, packageContext.sourceScopes))
        return target?.tableDocument ? createHover(target.tableDocument) : undefined
      }

      const matchedComponent = findPrefixedComponent(word, componentsPrefix, UiCompletions)
      if (matchedComponent?.tableDocument)
        return createHover(matchedComponent.tableDocument)
      if (UiCompletions[word]?.tableDocument)
        return createHover(UiCompletions[word].tableDocument)
      const target = await findDynamicComponent(word, {}, UiCompletions, optionsComponents.prefix)
      if (target?.tableDocument)
        return createHover(target.tableDocument)

      if (document.languageId === 'vue') {
        const parsed = getParsedResult()
        if (parsed?.type === 'tag' && parsed.tag) {
          const tag = fixedTagName(parsed.tag)
          const fallbackTarget = await findDynamicComponent(tag, {}, UiCompletions, componentsPrefix, normalizeScopedSource(uiDeps?.[tag], alias, packageContext.sourceScopes))
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
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(normalizeHostname(url.hostname)))
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
