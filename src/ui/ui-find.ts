import type * as vscode from 'vscode'
import type { OptionsComponents, PropsConfig, Uis } from './types'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createLog, getConfiguration, getCurrentFileUrl, getRootPath, watchFile } from '@vscode-use/utils'
import { findUp } from 'find-up'
import semver from 'semver'
import { UINames as configUINames } from '../constants'
import { fetchFromCommonIntellisense, fetchLocalSourceResults, fetchRemoteNpmSourceResults, fetchRemoteUrlSourceResults, getLocalCache, resolveLocalAdapterFile, writeLocalCache } from '../services/fetch'
import type { ComponentSourceScope } from '../services/component-resolver'
import { findComponentSourceScope, getPackageSource } from '../services/component-resolver'
import { clearPackageVersionCache, resolveInstalledPackageVersion } from '../services/package-version'
import { cacheMap, deactivateUICache as deactivateCache, disposeRootWatchers, getCacheMap, pkgUIConfigMap, removeRootPackageSubscriber, rootPkgCache, urlCache } from '../services/ui-cache'
import { clearTypeCache } from '../type-extract/cache'
import { formatUIName, getAlias, getPrefix, getSelectedUIs } from './ui-utils'

export const logger = createLog('common-intellisense')

interface ContextModel {
  optionsComponents: OptionsComponents
  uiCompletions: PropsConfig | null
  cacheMap: Map<string, any>
  sourceScopes: Map<string, ComponentSourceScope>
  sourceSignatures: Map<string, string>
}

interface CustomSourceSnapshot {
  exports: Record<string, any>
  signature: string
  /** Fully reduced in isolation; publication only composes validated projections. */
  model: ContextModel
}

type CustomSourceSnapshots = Map<string, CustomSourceSnapshot>

export interface PackageContext {
  cwd: string
  pkgPath: string
  workspaceRoot: string
  generation: number
  revision: number
  officialCheckedAt: number
  customSourcesCheckedAt: number
  officialLastAttemptAt: number
  customLastAttemptAt: number
  officialFailureCount: number
  customFailureCount: number
  officialNextRetryAt: number
  customNextRetryAt: number
  uiNames: string[]
  currentPkgUiNames: string[]
  userPrefix: Record<string, string>
  optionsComponents: OptionsComponents
  uiCompletions: PropsConfig | null
  cacheMap: Map<string, any>
  sourceScopes: Map<string, ComponentSourceScope>
  sourceSignatures: Map<string, string>
  officialModel: ContextModel
  customSourceSnapshots: CustomSourceSnapshots
}

const contexts = new Map<string, PackageContext>()

function setSourceScope(scopes: Map<string, ComponentSourceScope>, source: string, scope: ComponentSourceScope) {
  scopes.set(source, scope)
  scopes.set(formatUIName(source), scope)
}

function registerCompletionScopes(scopes: Map<string, ComponentSourceScope>, completion: PropsConfig, key: string, sources: string[], fallbackSource = key) {
  const canonicalLibs = new Set(
    (Object.values(completion) as any[])
      .map(item => typeof item?.lib === 'string' ? item.lib : undefined)
      .filter((lib): lib is string => !!lib),
  )
  const fallbackLib = fallbackSource.replace(/\d+$/, '')
  const acceptedLibs = canonicalLibs.size ? canonicalLibs : new Set([fallbackLib])
  // Declared package roots and wrappers select the adapter while accepting all
  // of its per-component dynamic module ids.
  for (const source of sources) {
    const root = getPackageSource(source)
    const broad: ComponentSourceScope = { key, acceptedLibs: new Set(acceptedLibs), ...(acceptedLibs.size === 1 ? { lib: [...acceptedLibs][0] } : {}) }
    setSourceScope(scopes, source, source === root ? broad : { key, acceptedLibs: new Set(acceptedLibs) })
    if (!scopes.has(root))
      setSourceScope(scopes, root, broad)
  }
  // Exact dynamic module paths never overwrite their package-root scope.
  for (const lib of canonicalLibs) {
    const root = getPackageSource(lib)
    if (lib === root && scopes.has(root))
      continue
    setSourceScope(scopes, lib, { key, exactLib: lib, acceptedLibs: new Set(acceptedLibs) })
  }
}

export function getSourceScope(context: Pick<PackageContext, 'sourceScopes'>, source: string | undefined) {
  return findComponentSourceScope(context.sourceScopes, source)
}
interface ContextLoad {
  epoch: number
  generation: number
  task: Promise<PackageContext | undefined>
}
const contextLoads = new Map<string, ContextLoad>()
const generations = new Map<string, number>()
const documentPackageCache = new Map<string, string | null>()
const mainWatchers = new Map<string, () => void>()
const maxInactivePackageContexts = 20
const sourceRefreshes = new Set<string>()
const localSourceWatchers = new Map<string, { stop: () => void, timer?: ReturnType<typeof setTimeout> }>()
const officialSourceTTL = 10 * 60 * 1000
const customSourceTTL = 5 * 60 * 1000
const sourceRetryDelays = [30_000, 2 * 60_000, 5 * 60_000]

function getRetryDelay(failureCount: number) {
  return sourceRetryDelays[Math.min(Math.max(failureCount - 1, 0), sourceRetryDelays.length - 1)]
}

function getSourceRefreshKey(kind: 'custom' | 'official', context: PackageContext) {
  return `${kind}:${context.pkgPath || context.cwd}:${context.generation}:${context.officialCheckedAt}`
}

let registryEpoch = 0
let volatileSnapshotSequence = 0
let officialSourceSignatureSequence = 0
let activeContext: PackageContext | undefined
const contextInvalidationListeners = new Set<(packagePaths?: string[]) => void>()
const contextUpdateListeners = new Set<(context: PackageContext) => void>()

export function onPackageContextsInvalidated(listener: (packagePaths?: string[]) => void) {
  contextInvalidationListeners.add(listener)
  return { dispose: () => contextInvalidationListeners.delete(listener) }
}

export function onPackageContextUpdated(listener: (context: PackageContext) => void) {
  contextUpdateListeners.add(listener)
  return { dispose: () => contextUpdateListeners.delete(listener) }
}

function notifyContextInvalidated(packagePaths?: string[]) {
  for (const listener of contextInvalidationListeners) {
    try { listener(packagePaths) }
    catch (error) { logger.error(`context invalidation listener failed: ${String(error)}`) }
  }
}

function notifyContextUpdated(context: PackageContext) {
  for (const listener of contextUpdateListeners) {
    try { listener(context) }
    catch (error) { logger.error(`context update listener failed: ${String(error)}`) }
  }
}

function emptyOptions(): OptionsComponents {
  return { prefix: [], data: [], directivesMap: {}, libs: [], providerKeys: new Set() }
}

function cloneModel(model: ContextModel): ContextModel {
  return {
    cacheMap: new Map(model.cacheMap),
    sourceScopes: new Map(model.sourceScopes),
    sourceSignatures: new Map(model.sourceSignatures),
    optionsComponents: {
      prefix: [...model.optionsComponents.prefix],
      data: [...model.optionsComponents.data],
      directivesMap: { ...model.optionsComponents.directivesMap },
      libs: [...model.optionsComponents.libs],
      providerKeys: new Set(model.optionsComponents.providerKeys),
    },
    uiCompletions: model.uiCompletions ? { ...model.uiCompletions } : null,
  }
}

let generationSequence = 0

function nextGeneration(key: string) {
  const generation = ++generationSequence
  generations.set(key, generation)
  return generation
}

function applyContext(context: PackageContext) {
  activeContext = context
  cacheMap.clear()
  for (const [key, value] of context.cacheMap)
    cacheMap.set(key, value)
}

function touchContext(pkgPath: string, context: PackageContext) {
  contexts.delete(pkgPath)
  contexts.set(pkgPath, context)
}

function disposePackageWatcher(pkgPath: string) {
  const stop = mainWatchers.get(pkgPath)
  if (!stop)
    return
  try { stop() }
  catch {}
  mainWatchers.delete(pkgPath)
}

function pruneInactiveContexts() {
  if (contexts.size <= maxInactivePackageContexts)
    return
  const referenced = new Set([...documentPackageCache.values()].filter((value): value is string => !!value))
  for (const [pkgPath] of contexts) {
    if (contexts.size <= maxInactivePackageContexts)
      break
    if (referenced.has(pkgPath))
      continue
    contexts.delete(pkgPath)
    contextLoads.delete(pkgPath)
    generations.delete(pkgPath)
    disposePackageWatcher(pkgPath)
    removeRootPackageSubscriber(pkgPath)
    for (const [documentPath, cached] of urlCache) {
      if (cached.pkg === pkgPath)
        urlCache.delete(documentPath)
    }
  }
}

export function releaseDocumentContext(documentPath: string) {
  documentPackageCache.delete(documentPath)
  urlCache.delete(documentPath)
  pruneInactiveContexts()
}

export function getContextRegistryStats() {
  return { contexts: contexts.size, documents: documentPackageCache.size, watchers: mainWatchers.size }
}

export function getContextForDocumentPath(cwd: string) {
  const packagePath = documentPackageCache.get(cwd)
  return packagePath ? contexts.get(packagePath) : contexts.get(cwd)
}

export function getContextForPackagePath(pkgPath: string) {
  return contexts.get(pkgPath)
}

export async function resolvePackagePathForDocument(cwd: string, refresh = false) {
  if (!cwd || cwd === 'exthhost')
    return
  if (!refresh && documentPackageCache.has(cwd))
    return documentPackageCache.get(cwd) || undefined
  const packagePath = await findUp('package.json', { cwd })
  if (packagePath)
    documentPackageCache.set(cwd, packagePath)
  else
    // Do not cache misses: a package may be scaffolded after the document opens.
    documentPackageCache.delete(cwd)
  return packagePath
}

/**
 * Invalidate document-to-package mappings affected by a package.json create or
 * delete event. Existing positive mappings remain hot until a manifest event
 * makes a nearer package root possible (or removes their current root).
 */
export function invalidateDocumentPackageMappingsForManifest(manifestPath: string) {
  const normalizedManifest = path.resolve(manifestPath)
  const manifestDirectory = path.dirname(normalizedManifest)
  for (const [documentPath, packagePath] of documentPackageCache) {
    if (packagePath === normalizedManifest || isSameOrWithin(documentPath, manifestDirectory)) {
      documentPackageCache.delete(documentPath)
      urlCache.delete(documentPath)
    }
  }
}

export async function ensureContextForPath(cwd: string, extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, cleanCache = false, workspaceRoot?: string) {
  if (!cwd || cwd === 'exthhost')
    return
  if (cleanCache)
    invalidateContexts()

  const pkgPath = await resolvePackagePathForDocument(cwd)
  if (!pkgPath)
    return
  const cachedDiscovery = urlCache.get(cwd)
  if (cachedDiscovery?.pkg !== pkgPath)
    urlCache.delete(cwd)

  const existing = contexts.get(pkgPath)
  if (existing) {
    touchContext(pkgPath, existing)
    documentPackageCache.set(cwd, pkgPath)
    applyContext(existing)
    revalidateStaleContext(existing, extensionContext, detectSlots, workspaceRoot || existing.workspaceRoot)
    return existing
  }
  const loading = contextLoads.get(pkgPath)
  if (loading)
    return loading.task

  const epoch = registryEpoch
  const generation = nextGeneration(pkgPath)
  const load = {} as ContextLoad
  load.epoch = epoch
  load.generation = generation
  load.task = (async () => {
    try {
      const context = await buildContext(cwd, extensionContext, detectSlots, generation, workspaceRoot || path.dirname(pkgPath))
      if (!context || registryEpoch !== epoch || generations.get(pkgPath) !== generation)
        return
      touchContext(context.pkgPath, context)
      documentPackageCache.set(cwd, context.pkgPath)
      pruneInactiveContexts()
      applyContext(context)
      notifyContextUpdated(context)
      startTrackedContextEnhancements(context, epoch)
      return context
    }
    finally {
      if (contextLoads.get(pkgPath) === load)
        contextLoads.delete(pkgPath)
    }
  })()
  contextLoads.set(pkgPath, load)
  return load.task
}

function maybeStartCustomRefresh(context: PackageContext, expectedEpoch: number, now = Date.now()) {
  const contextKey = context.pkgPath || context.cwd
  const latest = contexts.get(contextKey)
  if (!latest
    || registryEpoch !== expectedEpoch
    || latest.generation !== context.generation
    || now - latest.customSourcesCheckedAt < customSourceTTL
    || now < latest.customNextRetryAt
    || sourceRefreshes.has(getSourceRefreshKey('official', latest))) {
    return false
  }
  const refreshKey = getSourceRefreshKey('custom', latest)
  if (sourceRefreshes.has(refreshKey))
    return false
  latest.customLastAttemptAt = now
  latest.customNextRetryAt = now + sourceRetryDelays[0]
  sourceRefreshes.add(refreshKey)
  startContextEnhancements(latest, expectedEpoch, () => sourceRefreshes.delete(refreshKey))
  return true
}

function revalidateStaleContext(context: PackageContext, extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, workspaceRoot: string) {
  const contextKey = context.pkgPath || context.cwd
  const now = Date.now()
  const expectedEpoch = registryEpoch
  const officialDue = now - context.officialCheckedAt >= officialSourceTTL && now >= context.officialNextRetryAt
  if (!officialDue) {
    maybeStartCustomRefresh(context, expectedEpoch, now)
    return
  }

  // Avoid publishing custom snapshots on the old official baseline. The
  // official task always re-checks custom TTL when it settles, including errors.
  const refreshKey = getSourceRefreshKey('official', context)
  if (sourceRefreshes.has(refreshKey))
    return
  context.officialLastAttemptAt = now
  context.officialNextRetryAt = now + sourceRetryDelays[0]
  sourceRefreshes.add(refreshKey)
  void buildContext(context.cwd, extensionContext, detectSlots, context.generation, workspaceRoot, true)
    .then(async (refreshed) => {
      const registered = contexts.get(contextKey)
      if (!refreshed || registryEpoch !== expectedEpoch || !registered || registered.generation !== context.generation || registered.officialCheckedAt !== context.officialCheckedAt || generations.get(contextKey) !== context.generation)
        return
      const hadOfficialData = !!context.officialModel.uiCompletions || context.officialModel.optionsComponents.data.length > 0
      const hasRefreshedOfficialData = !!refreshed.officialModel.uiCompletions || refreshed.officialModel.optionsComponents.data.length > 0
      if (refreshed.officialFailureCount > 0 || (hadOfficialData && !hasRefreshedOfficialData))
        throw new Error('One or more official adapters failed to refresh')
      refreshed.customSourcesCheckedAt = registered.customSourcesCheckedAt
      refreshed.customLastAttemptAt = registered.customLastAttemptAt
      refreshed.customFailureCount = registered.customFailureCount
      refreshed.customNextRetryAt = registered.customNextRetryAt
      refreshed.officialLastAttemptAt = context.officialLastAttemptAt
      refreshed.officialFailureCount = 0
      refreshed.officialNextRetryAt = 0
      refreshed.customSourceSnapshots = new Map(registered.customSourceSnapshots)
      const composed = await composeContextFromSnapshots(refreshed, refreshed.customSourceSnapshots)
      const latest = contexts.get(contextKey)
      if (registryEpoch !== expectedEpoch || latest !== registered || generations.get(contextKey) !== context.generation)
        return
      composed.revision = latest.revision + 1
      contexts.set(contextKey, composed)
      applyContext(composed)
      notifyContextUpdated(composed)
    })
    .catch((error) => {
      const current = contexts.get(contextKey)
      if (registryEpoch === expectedEpoch && current?.generation === context.generation && current.officialCheckedAt === context.officialCheckedAt) {
        current.officialFailureCount++
        current.officialNextRetryAt = Date.now() + getRetryDelay(current.officialFailureCount)
      }
      logger.error(`official source refresh failed: ${String(error)}`)
    })
    .finally(() => {
      sourceRefreshes.delete(refreshKey)
      const latest = contexts.get(contextKey)
      if (latest)
        maybeStartCustomRefresh(latest, expectedEpoch)
    })
}

export async function findUI(extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, cleanCache?: boolean) {
  const cwd = getCurrentFileUrl()
  if (!cwd || cwd === 'exthhost')
    return
  try {
    return await ensureContextForPath(cwd, extensionContext, detectSlots, cleanCache)
  }
  catch (error: any) {
    logger.info(`findUI failed: ${error?.message || error}`)
  }
}

async function buildContext(cwd: string, extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, generation: number, workspaceRoot?: string, refreshDiscovery = false) {
  const onChange = () => {
    invalidatePackageContext(cwd)
    void ensureContextForPath(cwd, extensionContext, detectSlots, false, workspaceRoot)
      .catch(error => logger.error(`Failed to rebuild package context: ${String(error)}`))
  }
  const discovered = (!refreshDiscovery && urlCache.get(cwd)) || await findPkgUI(cwd, onChange, workspaceRoot)
  if (!discovered)
    return
  urlCache.set(cwd, discovered)
  const { pkg, uis } = discovered
  const context = await buildCompletions(uis, {
    selectedUIs: getSelectedUIs(pkg) || [],
    alias: getAlias(pkg) || {},
    detectSlots,
    prefix: getPrefix(pkg) || {},
    pkgPath: pkg,
    workspaceRoot,
  }, cwd, generation)
  logger.info(`findUI: ${uis.map(ui => ui.join('@')).join(' | ')}`)
  return context
}

export interface UpdateCompletionsOptions {
  selectedUIs: string[]
  alias: Record<string, string>
  detectSlots: (...args: any[]) => void
  prefix: Record<string, string>
  pkgPath?: string
  workspaceRoot?: string
}

export async function updateCompletions(uis: Uis, options: UpdateCompletionsOptions) {
  const cwd = options.pkgPath ? path.dirname(options.pkgPath) : getCurrentFileUrl() || ''
  const contextKey = options.pkgPath || cwd
  const context = await buildCompletions(uis, options, cwd, nextGeneration(contextKey))
  contexts.set(contextKey, context)
  applyContext(context)
  notifyContextUpdated(context)
  startTrackedContextEnhancements(context, registryEpoch)
  return context
}

async function buildCompletions(uis: Uis, options: UpdateCompletionsOptions, cwd: string, generation: number): Promise<PackageContext> {
  const { selectedUIs, alias, prefix: userPrefix, pkgPath = '', workspaceRoot = path.dirname(pkgPath) } = options
  await getLocalCache
  const localCache = new Map<string, any>()
  const localUI: Record<string, (options?: { resolveFrom?: string, installedVersion?: string, adapterMajor?: string }) => any> = {}
  const localOptions = emptyOptions()
  let localCompletions: PropsConfig | null = null
  const availableNames: string[] = []
  const originNames: string[] = []
  const formatToPkg = new Map<string, { pkgName: string, version: string, installedVersion?: string, adapterMajor: string }>()
  const selectionToAdapter = new Map<string, string>()
  const sourceScopes = new Map<string, ComponentSourceScope>()
  const sourceSignatures = new Map<string, string>()
  const adapterSources = new Map<string, string[]>()

  for (const [declaredName, version] of uis) {
    let uiName = declaredName
    let major = extractMajor(version) || '0'
    let installedVersion = semver.valid(version) || undefined
    if (uiName in alias) {
      const parsedAlias = parseAlias(alias[uiName])
      uiName = parsedAlias.name || uiName
      major = parsedAlias.major || major
      const underlyingPackageName = configUINames.find(candidate => formatUIName(candidate) === formatUIName(uiName)) || uiName
      installedVersion = await resolveInstalledPackageVersion(underlyingPackageName, path.dirname(pkgPath))
      uiName = underlyingPackageName
      originNames.push(`${declaredName}${major}`)
    }
    else {
      originNames.push(`${declaredName}${major}`)
    }
    const formatName = `${formatUIName(uiName)}${major}`
    const selectionName = `${declaredName}${major}`
    formatToPkg.set(formatName, { pkgName: uiName, version: major, installedVersion, adapterMajor: major })
    selectionToAdapter.set(formatName, formatName)
    selectionToAdapter.set(selectionName, formatName)
    availableNames.push(formatName)
    adapterSources.set(formatName, [...(adapterSources.get(formatName) || []), declaredName, uiName])
  }

  const hasExplicitSelection = Array.isArray(selectedUIs) && !selectedUIs.includes('auto')
  const selected = hasExplicitSelection
    ? selectedUIs.map(item => selectionToAdapter.get(item)).filter((item): item is string => !!item)
    : []
  const uiNames = hasExplicitSelection ? [...new Set(selected)] : availableNames

  // Fetch independently, then merge in configured order so network timing never
  // changes collision precedence.
  const loadedLibraries = await Promise.all(uiNames.map(async (name) => {
    const pkgInfo = formatToPkg.get(name)
    try {
      const exports = await fetchFromCommonIntellisense(
        name.replace(/([A-Z])/g, '-$1').toLowerCase(),
        pkgInfo ? { pkgName: pkgInfo.pkgName, uiName: name, resolveFrom: pkgPath, installedVersion: pkgInfo.installedVersion, adapterMajor: pkgInfo.adapterMajor } : { uiName: name, resolveFrom: pkgPath },
      )
      const hasExpectedExport = !!(exports?.[name] || exports?.[`${name}Components`])
      return { name, pkgInfo, exports, failed: !hasExpectedExport }
    }
    catch (error) {
      logger.error(`fetch fetchFromCommonIntellisense [${name}] error: ${String(error)}`)
      return { name, pkgInfo, exports: undefined, failed: true }
    }
  }))

  let officialLoadFailed = uiNames.length > 0 && loadedLibraries.some(item => item.failed)
  const officialBuildSignature = `official-build:${++officialSourceSignatureSequence}`

  for (const { name, pkgInfo, exports } of loadedLibraries) {
    if (!exports)
      continue
    Object.assign(localUI, exports)
    const componentsKey = `${name}Components`
    try {
      const components = exports[componentsKey]?.()
      if (components) {
        localCache.set(componentsKey, components)
        const sourceId = `official:${name}`
        const sourceSignature = `${officialBuildSignature}:${name}@${pkgInfo?.installedVersion || pkgInfo?.adapterMajor || 'unknown'}`
        sourceSignatures.set(sourceId, sourceSignature)
        mergeComponents(localOptions, components, userPrefix, originNames, name, `official:${name}:${componentsKey}`, sourceId, sourceSignature)
      }
    }
    catch (error) {
      officialLoadFailed = true
      logger.error(`official components export [${componentsKey}] failed: ${String(error)}`)
    }
    try {
      const completion = await exports[name]?.({ resolveFrom: pkgPath, installedVersion: pkgInfo?.installedVersion, adapterMajor: pkgInfo?.adapterMajor })
      if (completion) {
        localCache.set(name, completion)
        localCompletions ||= {} as PropsConfig
        Object.assign(localCompletions, completion)
        registerCompletionScopes(
          sourceScopes,
          completion,
          name,
          adapterSources.get(name) || [pkgInfo?.pkgName || name],
        )
      }
    }
    catch (error) {
      officialLoadFailed = true
      logger.error(`official props export [${name}] failed: ${String(error)}`)
    }
  }

  void writeLocalCache().catch(error => logger.error(`cache write failed: ${String(error)}`))

  const checkedAt = Date.now()
  const officialModel: ContextModel = { optionsComponents: localOptions, uiCompletions: localCompletions, cacheMap: localCache, sourceScopes, sourceSignatures }
  return {
    cwd,
    pkgPath,
    workspaceRoot,
    generation,
    revision: 1,
    officialCheckedAt: officialLoadFailed ? 0 : checkedAt,
    customSourcesCheckedAt: 0,
    officialLastAttemptAt: checkedAt,
    customLastAttemptAt: 0,
    officialFailureCount: officialLoadFailed ? 1 : 0,
    customFailureCount: 0,
    officialNextRetryAt: officialLoadFailed ? checkedAt + getRetryDelay(1) : 0,
    customNextRetryAt: 0,
    uiNames,
    currentPkgUiNames: availableNames,
    userPrefix,
    ...cloneModel(officialModel),
    officialModel,
    customSourceSnapshots: new Map(),
  }
}

async function getConfiguredLocalSourcePaths(workspaceRoot: string, allowMissing = false) {
  const uris = (getConfiguration('common-intellisense.localUris') as string[] | undefined) || []
  const resolved = await Promise.all(uris.map(uri => resolveLocalAdapterFile(workspaceRoot, uri, { allowMissing })))
  return resolved.filter((sourcePath): sourcePath is string => !!sourcePath)
}

export async function resetCustomSourcesForApprovalChange() {
  const expectedEpoch = registryEpoch
  for (const [contextKey, current] of [...contexts]) {
    if (registryEpoch !== expectedEpoch || contexts.get(contextKey) !== current)
      continue
    const resetGeneration = nextGeneration(contextKey)
    const reset: PackageContext = {
      ...current,
      ...cloneModel(current.officialModel),
      generation: resetGeneration,
      revision: current.revision + 1,
      customSourcesCheckedAt: 0,
      customLastAttemptAt: 0,
      customFailureCount: 0,
      customNextRetryAt: 0,
      customSourceSnapshots: new Map(),
    }
    contexts.set(contextKey, reset)
    if (activeContext?.pkgPath === current.pkgPath)
      applyContext(reset)
    notifyContextUpdated(reset)
    startTrackedContextEnhancements(reset, expectedEpoch)
  }
}

export async function handleLocalSourceChanged(workspaceRoot: string, sourcePath: string) {
  const resolvedSource = path.resolve(sourcePath)
  const safePaths = await getConfiguredLocalSourcePaths(workspaceRoot, true)
  if (!safePaths.includes(resolvedSource))
    return
  const sourceId = `local:${resolvedSource}`
  const exists = await fsp.stat(resolvedSource).then(stat => stat.isFile(), () => false)
  for (const context of [...contexts.values()]) {
    if (path.resolve(context.workspaceRoot) !== path.resolve(workspaceRoot))
      continue
    context.customSourcesCheckedAt = 0
    context.customNextRetryAt = 0
    if (!exists && context.customSourceSnapshots.has(sourceId)) {
      const snapshots = new Map(context.customSourceSnapshots)
      snapshots.delete(sourceId)
      await publishContextEnhancement(context, registryEpoch, snapshots)
      continue
    }
    const officialKey = getSourceRefreshKey('official', context)
    if (!sourceRefreshes.has(officialKey))
      startTrackedContextEnhancements(context, registryEpoch)
  }
}

async function ensureLocalSourceWatchers(context: PackageContext) {
  const configuredPaths = await getConfiguredLocalSourcePaths(context.workspaceRoot, true)
  const rootPrefix = `${path.resolve(context.workspaceRoot)}\0`
  for (const [key, entry] of localSourceWatchers) {
    if (key.startsWith(rootPrefix) && !configuredPaths.some(sourcePath => key === `${rootPrefix}${sourcePath}`)) {
      entry.stop()
      if (entry.timer)
        clearTimeout(entry.timer)
      localSourceWatchers.delete(key)
    }
  }
  for (const sourcePath of configuredPaths) {
    const key = `${path.resolve(context.workspaceRoot)}\0${sourcePath}`
    if (localSourceWatchers.has(key))
      continue
    const entry: { stop: () => void, timer?: ReturnType<typeof setTimeout> } = { stop: () => {} }
    entry.stop = watchFile(sourcePath, {
      onChange: () => {
        if (entry.timer)
          clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          void handleLocalSourceChanged(context.workspaceRoot, sourcePath).catch(error => logger.error(`local source refresh failed: ${String(error)}`))
        }, 200)
      },
    })
    localSourceWatchers.set(key, entry)
  }
}

function startTrackedContextEnhancements(context: PackageContext, expectedEpoch: number) {
  void ensureLocalSourceWatchers(context).catch(error => logger.error(`local source watcher setup failed: ${String(error)}`))
  const refreshKey = getSourceRefreshKey('custom', context)
  if (sourceRefreshes.has(refreshKey))
    return
  context.customLastAttemptAt = Date.now()
  context.customNextRetryAt = context.customLastAttemptAt + sourceRetryDelays[0]
  sourceRefreshes.add(refreshKey)
  startContextEnhancements(context, expectedEpoch, () => sourceRefreshes.delete(refreshKey))
}

async function prepareCustomSnapshot(context: PackageContext, sourceId: string, exports: Record<string, any>, signature: string): Promise<CustomSourceSnapshot> {
  const model: ContextModel = { optionsComponents: emptyOptions(), uiCompletions: null, cacheMap: new Map(), sourceScopes: new Map(), sourceSignatures: new Map([[sourceId, signature]]) }
  for (const key of Object.keys(exports)) {
    const scopedKey = `custom:${sourceId}:${key}`
    if (key.endsWith('Components')) {
      const components = exports[key]?.()
      if (components) {
        model.cacheMap.set(scopedKey, components)
        const directiveKey = `custom:${sourceId}:${key.slice(0, -'Components'.length)}`
        mergeComponents(model.optionsComponents, components, context.userPrefix, [], directiveKey, scopedKey, sourceId, signature)
      }
      continue
    }
    const completion = await exports[key]?.({ resolveFrom: context.pkgPath })
    if (!completion)
      continue
    for (const item of Object.values(completion) as any[])
      item.uiName = scopedKey
    model.cacheMap.set(scopedKey, completion)
    model.uiCompletions ||= {} as PropsConfig
    Object.assign(model.uiCompletions, completion)
    registerCompletionScopes(
      model.sourceScopes,
      completion,
      scopedKey,
      [key, key.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')],
      key,
    )
  }
  return { exports, signature, model }
}

function startContextEnhancements(context: PackageContext, expectedEpoch: number, onSettled?: () => void) {
  const loaders = [
    { prefix: 'local:', load: () => fetchLocalSourceResults(context.workspaceRoot) },
    { prefix: 'http:', load: fetchRemoteUrlSourceResults },
    { prefix: 'npm:', load: fetchRemoteNpmSourceResults },
  ]
  // Loader preparation is concurrent, but aggregate snapshot replacement is
  // serialized. Never remove a prefix from the shared aggregate before an
  // awaited reducer has completed: another loader could otherwise publish that
  // transient, incomplete Map and permanently drop last-known-good metadata.
  let committedSnapshots: CustomSourceSnapshots = new Map(context.customSourceSnapshots)
  let publishQueue: Promise<void> = Promise.resolve()
  let publishedAny = false
  let loaderFailed = false
  let publicationFailed = false

  const prefixEntries = (snapshots: CustomSourceSnapshots, prefix: string) =>
    [...snapshots].filter(([id]) => id.startsWith(prefix))

  const samePrefixSnapshots = (left: CustomSourceSnapshots, right: CustomSourceSnapshots, prefix: string) => {
    const leftEntries = prefixEntries(left, prefix)
    const rightEntries = prefixEntries(right, prefix)
    return leftEntries.length === rightEntries.length
      && leftEntries.every(([id, snapshot]) => right.get(id) === snapshot)
  }

  const loaderTasks = loaders.map(({ prefix, load }) => Promise.resolve()
    .then(load)
    .then(async (results) => {
      // Prepare this source class in isolation from the other concurrent
      // loaders. A failed source explicitly retains its baseline snapshot;
      // sources absent from a successful result are intentionally removed.
      const baselinePrefix = new Map(prefixEntries(context.customSourceSnapshots, prefix))
      const preparedPrefix: CustomSourceSnapshots = new Map()
      for (const result of results) {
        const old = baselinePrefix.get(result.id)
        if (result.status === 'success') {
          const signature = result.signature || `volatile:${++volatileSnapshotSequence}`
          if (old && result.signature && old.signature === result.signature) {
            preparedPrefix.set(result.id, old)
          }
          else {
            try {
              preparedPrefix.set(result.id, await prepareCustomSnapshot(context, result.id, result.value || {}, signature))
            }
            catch (error) {
              loaderFailed = true
              if (old)
                preparedPrefix.set(result.id, old)
              logger.error(`custom source reduction failed [${result.id}]: ${String(error)}`)
            }
          }
        }
        else {
          if (old)
            preparedPrefix.set(result.id, old)
          loaderFailed = true
          logger.error(`custom source failed [${result.id}]: ${String(result.error)}`)
        }
      }

      publishQueue = publishQueue.then(async () => {
        if (samePrefixSnapshots(committedSnapshots, preparedPrefix, prefix))
          return
        const next = new Map(committedSnapshots)
        for (const id of next.keys()) {
          if (id.startsWith(prefix))
            next.delete(id)
        }
        for (const [id, snapshot] of preparedPrefix)
          next.set(id, snapshot)
        committedSnapshots = next
        try {
          const published = await publishContextEnhancement(context, expectedEpoch, new Map(next))
          publishedAny ||= !!published
        }
        catch (error) {
          publicationFailed = true
          logger.error(`custom source enhancement failed: ${String(error)}`)
        }
      })
    })
    .catch((error) => {
      loaderFailed = true
      logger.error(`custom source loader failed: ${String(error)}`)
    }))

  void Promise.allSettled(loaderTasks)
    .then(async () => {
      // Every fulfilled loader has enqueued its publication before its task
      // settles, so this waits for the complete, latest publication queue.
      await publishQueue
      const current = contexts.get(context.pkgPath || context.cwd)
      if (!loaderFailed
        && !publicationFailed
        && registryEpoch === expectedEpoch
        && current?.generation === context.generation
        && current.officialCheckedAt === context.officialCheckedAt) {
        current.customSourcesCheckedAt = Date.now()
        current.customFailureCount = 0
        current.customNextRetryAt = 0
      }
      else if (registryEpoch === expectedEpoch
        && current?.generation === context.generation
        && current.officialCheckedAt === context.officialCheckedAt) {
        current.customFailureCount++
        current.customNextRetryAt = Date.now() + getRetryDelay(current.customFailureCount)
      }
    })
    .finally(() => onSettled?.())
}

async function composeContextFromSnapshots(context: PackageContext, snapshots: CustomSourceSnapshots) {
  const snapshotCopy: CustomSourceSnapshots = new Map(snapshots)
  const composed: PackageContext = {
    ...context,
    ...cloneModel(context.officialModel),
    customSourceSnapshots: snapshotCopy,
  }

  const sourceOrder = (id: string) => id.startsWith('local:') ? 0 : id.startsWith('http:') ? 1 : 2
  const orderedSnapshots = [...snapshotCopy.entries()].sort(([a], [b]) => sourceOrder(a) - sourceOrder(b) || a.localeCompare(b))
  for (const [, snapshot] of orderedSnapshots) {
    const model = snapshot.model
    for (const [key, value] of model.cacheMap)
      composed.cacheMap.set(key, value)
    for (const [key, value] of model.sourceScopes)
      composed.sourceScopes.set(key, value)
    for (const [key, value] of model.sourceSignatures)
      composed.sourceSignatures.set(key, value)
    if (model.uiCompletions) {
      composed.uiCompletions ||= {} as PropsConfig
      Object.assign(composed.uiCompletions, model.uiCompletions)
    }
    composed.optionsComponents.prefix.push(...model.optionsComponents.prefix.filter(prefix => !composed.optionsComponents.prefix.includes(prefix)))
    composed.optionsComponents.libs.push(...model.optionsComponents.libs.filter(lib => !composed.optionsComponents.libs.includes(lib)))
    composed.optionsComponents.data.push(...model.optionsComponents.data)
    Object.assign(composed.optionsComponents.directivesMap, model.optionsComponents.directivesMap)
    for (const key of model.optionsComponents.providerKeys || [])
      composed.optionsComponents.providerKeys?.add(key)
  }
  return composed
}

async function publishContextEnhancement(context: PackageContext, expectedEpoch: number, sourceResults: CustomSourceSnapshots) {
  if (registryEpoch !== expectedEpoch)
    return
  const contextKey = context.pkgPath || context.cwd
  const current = contexts.get(contextKey)
  const latestGeneration = generations.get(contextKey) ?? generations.get(context.cwd)
  if (!current || current.generation !== context.generation || current.officialCheckedAt !== context.officialCheckedAt || latestGeneration !== context.generation)
    return

  const enhanced = await composeContextFromSnapshots(context, sourceResults)
  const registered = contexts.get(contextKey)
  const generation = generations.get(contextKey) ?? generations.get(context.cwd)
  if (registryEpoch !== expectedEpoch || registered !== current || registered.generation !== context.generation || registered.officialCheckedAt !== context.officialCheckedAt || generation !== context.generation)
    return
  enhanced.revision = registered.revision + 1
  enhanced.customSourcesCheckedAt = registered.customSourcesCheckedAt
  enhanced.officialLastAttemptAt = registered.officialLastAttemptAt
  enhanced.customLastAttemptAt = registered.customLastAttemptAt
  enhanced.officialFailureCount = registered.officialFailureCount
  enhanced.customFailureCount = registered.customFailureCount
  enhanced.officialNextRetryAt = registered.officialNextRetryAt
  enhanced.customNextRetryAt = registered.customNextRetryAt
  contexts.set(contextKey, enhanced)
  applyContext(enhanced)
  notifyContextUpdated(enhanced)
  void writeLocalCache().catch(error => logger.error(`cache write failed: ${String(error)}`))
  return enhanced
}

export function mergeComponents(target: OptionsComponents, components: any[], userPrefix: Record<string, string>, originNames: string[], fallbackName: string, sourceId = fallbackName, completionSourceId?: string, sourceSignature?: string) {
  for (const component of components) {
    let { prefix, data, directives, lib } = component
    if (userPrefix?.[lib])
      prefix = userPrefix[lib]
    const providerKey = `${sourceId}\0${lib}\0${prefix}`
    target.providerKeys ||= new Set()
    if (target.providerKeys.has(providerKey))
      continue
    target.providerKeys.add(providerKey)
    if (!target.libs.includes(lib))
      target.libs.push(lib)
    if (!target.prefix.includes(prefix))
      target.prefix.push(prefix)
    const providers = Array.isArray(data) ? data : [data]
    target.data.push(...providers.map((provider: any) => (parent: any, context: any) => provider(parent, completionSourceId ? { ...context, sourceId: completionSourceId, sourceSignature } : context)))
    target.directivesMap[fallbackName] = directives
  }
}

export interface ParsedDependency {
  packageName?: string
  major?: string
  range?: string
  requiresInstalledVersion: boolean
}

function parseSemverRange(value: string): ParsedDependency {
  const range = semver.validRange(value)
  if (!range)
    return { requiresInstalledVersion: true }
  const minimum = semver.minVersion(range)
  return {
    major: minimum ? String(minimum.major) : undefined,
    range,
    requiresInstalledVersion: false,
  }
}

export function parseDeclaredDependency(spec: unknown): ParsedDependency {
  if (typeof spec !== 'string' || !spec.trim())
    return { requiresInstalledVersion: true }
  const value = spec.trim()
  if (/^(?:file|link|patch|git\+|https?|github|gitlab|bitbucket):/i.test(value) || /^(?:latest|next|beta|canary|\*)$/i.test(value))
    return { requiresInstalledVersion: true }
  if (value.startsWith('npm:')) {
    const match = value.slice(4).match(/^((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/)
    const parsed = parseSemverRange(match?.[2] || '')
    return { ...parsed, packageName: match?.[1] }
  }
  const protocol = value.match(/^(?:workspace|catalog|catelog):(.*)$/i)
  if (protocol) {
    if (!protocol[1] || protocol[1] === '*')
      return { requiresInstalledVersion: true }
    return parseSemverRange(protocol[1])
  }
  return parseSemverRange(value)
}

function extractMajor(value: unknown) {
  if (typeof value !== 'string')
    return undefined
  return value.match(/(?:^|\D)(\d+)(?:\.\d+|\.x|\b)/)?.[1]
}

function parseAlias(value: string) {
  const match = value?.match(/^(.*\D)(\d+)$/)
  return { name: match?.[1], major: match?.[2] }
}

export function collectDependencyScopes(manifest: any, rootPkg: any) {
  const rootDependencies = {
    ...(rootPkg?.dependencies || {}),
    ...(rootPkg?.peerDependencies || {}),
    ...(rootPkg?.devDependencies || {}),
    ...(rootPkg?.optionalDependencies || {}),
  }
  const localDependencies = {
    ...(manifest?.dependencies || {}),
    ...(manifest?.peerDependencies || {}),
    ...(manifest?.devDependencies || {}),
    ...(manifest?.optionalDependencies || {}),
  }
  return {
    rootDependencies,
    localDependencies,
    dependencies: { ...rootDependencies, ...localDependencies },
  }
}

export function getDependencyResolveFrom(key: string, localDependencies: Record<string, unknown>, pkgDir: string, rootPath?: string) {
  return key in localDependencies ? pkgDir : rootPath
}

export function selectDependencyVersion(installed: string | undefined, declaredMajor: string | undefined, declaredRange?: string) {
  if (installed && (!declaredRange || semver.satisfies(installed, declaredRange, { includePrerelease: true })))
    return installed
  return declaredMajor
}

async function computeMonorepoState(rootPath: string, rootPkg: any) {
  if (rootPkg?.workspaces || rootPkg?.pnpm?.workspaces)
    return true
  try {
    await fsp.access(path.resolve(rootPath, 'pnpm-workspace.yaml'))
    return true
  }
  catch {
    return false
  }
}

export async function findPkgUI(cwd?: string, onChange?: () => void, workspaceRoot?: string) {
  if (!cwd)
    return
  const pkg = await findUp('package.json', { cwd })
  if (!pkg)
    return
  const alias = getAlias(pkg) || {}
  const pkgDir = path.dirname(pkg)
  let rootPkgPath = ''
  let rootPkg: any = null
  let isMonorepo = false
  const rootPath = workspaceRoot || getRootPath()
  if (rootPath) {
    const cached = rootPkgCache.get(rootPath)
    if (cached) {
      ({ rootPkgPath, rootPkg, isMonorepo } = cached)
      // A root package watcher may have fired since this entry was created.
      // Re-read the small manifest so dependency changes cannot reuse stale data.
      if (rootPkgPath && rootPkgPath !== pkg) {
        try {
          rootPkg = JSON.parse(await fsp.readFile(rootPkgPath, 'utf8'))
          isMonorepo = await computeMonorepoState(rootPath, rootPkg)
          cached.rootPkg = rootPkg
          cached.isMonorepo = isMonorepo
        }
        catch {
          rootPkg = null
          isMonorepo = await computeMonorepoState(rootPath, null)
          cached.rootPkg = null
          cached.isMonorepo = isMonorepo
        }
      }
    }
    else {
      rootPkgPath = path.resolve(rootPath, 'package.json')
      if (rootPkgPath !== pkg) {
        try {
          rootPkg = JSON.parse(await fsp.readFile(rootPkgPath, 'utf8'))
          isMonorepo = await computeMonorepoState(rootPath, rootPkg)
        }
        catch {}
      }
      rootPkgCache.set(rootPath, { rootPkgPath, rootPkg, isMonorepo, subscribers: new Map() })
    }
  }

  if (onChange && rootPath && rootPkgPath && rootPkgPath !== pkg) {
    const cached = rootPkgCache.get(rootPath)!
    cached.subscribers ||= new Map()
    cached.subscribers.set(pkg, onChange)
  }

  if (onChange && !mainWatchers.has(pkg)) {
    // buildContext's callback owns invalidation and rebuild. Wrapping it with a
    // second invalidation advances generations and clears shared caches twice.
    mainWatchers.set(pkg, watchFile(pkg, { onChange }))
    // A root manifest is shared by every child package. Rebuild all subscribed
    // children rather than only the package that created this watcher.
    if (rootPath && rootPkgPath && rootPkgPath !== pkg) {
      const cached = rootPkgCache.get(rootPath)!
      if (!cached.stopRoot) {
        cached.stopRoot = watchFile(rootPkgPath, {
          onChange: () => {
            const subscribers = [...(cached.subscribers?.values() || [])]
            invalidatePackageContext(rootPath)
            for (const rebuild of subscribers)
              rebuild()
          },
        })
      }
    }
  }

  if (onChange && rootPath && rootPkgPath && rootPkgPath !== pkg) {
    const cached = rootPkgCache.get(rootPath)!
    if (!cached.stopWorkspace) {
      try {
        const watcher = fs.watch(rootPath, (_event, filename) => {
          if (filename?.toString() !== 'pnpm-workspace.yaml')
            return
          cached.isMonorepo = false
          const subscribers = [...(cached.subscribers?.values() || [])]
          invalidatePackageContext(rootPath)
          for (const rebuild of subscribers)
            rebuild()
        })
        cached.stopWorkspace = () => watcher.close()
      }
      catch {}
    }
  }

  const manifest = JSON.parse(await fsp.readFile(pkg, 'utf8'))
  const dependencyRootPkg = isMonorepo ? rootPkg : null
  const { localDependencies, dependencies: deps } = collectDependencyScopes(manifest, dependencyRootPkg)
  const aliasUiNames = Object.keys(alias)
  const result: Uis = []
  for (const key of Object.keys(deps)) {
    if (!configUINames.includes(key) && !aliasUiNames.includes(key))
      continue
    const declared = deps[key]
    const parsed = parseDeclaredDependency(declared)
    const resolveFrom = getDependencyResolveFrom(key, localDependencies, pkgDir, rootPath)
    // npm aliases are installed and resolved under the dependency key in the
    // consuming project (for example `antd`), not under the target package's
    // declared name. Fall back to the target identity for non-standard layouts.
    const installed = await resolveInstalledPackageVersion(key, resolveFrom)
      ?? (parsed.packageName && parsed.packageName !== key
        ? await resolveInstalledPackageVersion(parsed.packageName, resolveFrom)
        : undefined)
    const version = selectDependencyVersion(installed, parsed.major, parsed.range)
    if (!version) {
      logger.error(`${key} version is unsupported: ${declared}`)
      continue
    }
    result.push([key, version])
  }
  return { pkg, uis: result }
}

function isSameOrWithin(target: string, parent: string) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function invalidatePackageContext(cwdOrPkg: string) {
  const affectedPackages = new Set<string>()
  const cachedPackage = documentPackageCache.get(cwdOrPkg)
  if (cachedPackage)
    affectedPackages.add(cachedPackage)
  if (path.basename(cwdOrPkg) === 'package.json')
    affectedPackages.add(cwdOrPkg)

  for (const [key, context] of contexts) {
    const root = path.dirname(context.pkgPath)
    if (key === cwdOrPkg || context.pkgPath === cwdOrPkg || isSameOrWithin(cwdOrPkg, root) || isSameOrWithin(root, cwdOrPkg))
      affectedPackages.add(context.pkgPath)
  }
  for (const pkgPath of contextLoads.keys()) {
    const root = path.dirname(pkgPath)
    if (pkgPath === cwdOrPkg || isSameOrWithin(cwdOrPkg, root) || isSameOrWithin(root, cwdOrPkg))
      affectedPackages.add(pkgPath)
  }

  for (const pkgPath of affectedPackages) {
    nextGeneration(pkgPath)
    contexts.delete(pkgPath)
    contextLoads.delete(pkgPath)
    disposePackageWatcher(pkgPath)
    removeRootPackageSubscriber(pkgPath)
  }
  for (const [documentPath, packagePath] of documentPackageCache) {
    if (packagePath && (affectedPackages.has(packagePath) || isSameOrWithin(documentPath, cwdOrPkg)))
      documentPackageCache.delete(documentPath)
  }
  for (const key of urlCache.keys()) {
    const cached = urlCache.get(key)
    if (isSameOrWithin(key, cwdOrPkg) || (cached && affectedPackages.has(cached.pkg)))
      urlCache.delete(key)
  }
  if (affectedPackages.size)
    notifyContextInvalidated([...affectedPackages])
  clearPackageVersionCache()
  clearTypeCache()
  cacheMap.clear()
  pkgUIConfigMap.clear()
}

export function invalidateContexts() {
  registryEpoch++
  disposeUIWatchers()
  disposeRootWatchers()
  contexts.clear()
  contextLoads.clear()
  sourceRefreshes.clear()
  documentPackageCache.clear()
  urlCache.clear()
  cacheMap.clear()
  pkgUIConfigMap.clear()
  clearPackageVersionCache()
  clearTypeCache()
  activeContext = undefined
  notifyContextInvalidated()
}

export function disposeUIWatchers() {
  for (const stop of mainWatchers.values()) {
    try { stop() }
    catch {}
  }
  mainWatchers.clear()
  for (const watcher of localSourceWatchers.values()) {
    if (watcher.timer)
      clearTimeout(watcher.timer)
    try { watcher.stop() }
    catch {}
  }
  localSourceWatchers.clear()
}

export function getCurrentPkgUiNames() {
  return activeContext?.currentPkgUiNames || null
}

export function getOptionsComponents() {
  return activeContext?.optionsComponents || emptyOptions()
}

export function getUiCompletions() {
  return activeContext?.uiCompletions || null
}

export function deactivateUICache() {
  disposeUIWatchers()
  invalidateContexts()
  contextInvalidationListeners.clear()
  contextUpdateListeners.clear()
  deactivateCache()
}

export { getCacheMap, urlCache }
