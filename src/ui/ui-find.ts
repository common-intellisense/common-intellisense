import * as vscode from 'vscode'
import type { OptionsComponents, PropsConfig, Uis } from './types'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createLog, getConfiguration, getCurrentFileUrl, getLocale, getRootPath, watchFile } from '@vscode-use/utils'
import { findUp } from 'find-up'
import semver from 'semver'
import { UINames as configUINames } from '../constants'
import { fetchFromCommonIntellisense, fetchLocalSourceResults, fetchRemoteNpmSourceResults, fetchRemoteUrlSourceResults, getLocalCache, resolveLocalAdapterFile, writeLocalCache } from '../services/fetch'
import type { ComponentSourceScope } from '../services/component-resolver'
import { findComponentSourceScope, getPackageSource } from '../services/component-resolver'
import { clearPackageVersionCache, resolveInstalledPackageVersion } from '../services/package-version'
import { cacheMap, deactivateUICache as deactivateCache, disposeRootPackageCache, disposeRootWatchers, getCacheMap, pkgUIConfigMap, removeRootPackageSubscriber, rootPkgCache, urlCache } from '../services/ui-cache'
import { clearTypeCache } from '../type-extract/cache'
import { formatUIName, getAlias, getPrefix, getSelectedUIs } from './ui-utils'

export const logger = createLog('common-intellisense')

interface AdapterRuntimeOptions {
  resolveFrom?: string
  installedVersion?: string
  adapterMajor?: string
}

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
  reductionSignature: string
  configurationIndex: number
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
  customSourceEpoch: number
  customRefreshPending: boolean
  uiNames: string[]
  currentPkgUiNames: string[]
  userPrefix: Record<string, string>
  adapterRuntimeOptions: Map<string, AdapterRuntimeOptions>
  optionsComponents: OptionsComponents
  uiCompletions: PropsConfig | null
  cacheMap: Map<string, any>
  sourceScopes: Map<string, ComponentSourceScope>
  sourceSignatures: Map<string, string>
  officialModel: ContextModel
  customSourceSnapshots: CustomSourceSnapshots
  manifestSignature?: string
  rootManifestPath?: string
  rootManifestSignature?: string
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
  pkgPath: string
  workspaceRoot: string
  task: Promise<PackageContext | undefined>
}
interface PackageWatcherEntry {
  stop: () => void
  subscribers: Map<string, () => void>
}
const contextLoads = new Map<string, ContextLoad>()
const generations = new Map<string, number>()
const documentPackageCache = new Map<string, string | null>()
const documentContextCache = new Map<string, string>()
const mainWatchers = new Map<string, PackageWatcherEntry>()
const maxInactivePackageContexts = 20
const sourceRefreshes = new Set<string>()
const localSourceWatchers = new Map<string, { stop: () => void, timer?: ReturnType<typeof setTimeout> }>()
const officialSourceTTL = 10 * 60 * 1000
const customSourceTTL = 5 * 60 * 1000
const sourceRetryDelays = [30_000, 2 * 60_000, 5 * 60_000]
const legacySelectionAliases: Record<string, string> = {
  nextui2: 'nextUi2',
  nuxtui2: 'nuxtUi2',
  arkUi4: 'arkVue4',
}

function getRetryDelay(failureCount: number) {
  return sourceRetryDelays[Math.min(Math.max(failureCount - 1, 0), sourceRetryDelays.length - 1)]
}

function getSourceRefreshKey(kind: 'custom' | 'official', context: PackageContext) {
  return `${kind}:${getContextKeyForContext(context)}:${context.generation}:${context.officialCheckedAt}`
}

let registryEpoch = 0
let volatileSnapshotSequence = 0
let officialSourceSignatureSequence = 0
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

function getContextKey(workspaceRoot: string, pkgPath: string) {
  return `${path.resolve(workspaceRoot)}\0${path.resolve(pkgPath)}`
}

function getContextKeyForContext(context: Pick<PackageContext, 'pkgPath' | 'workspaceRoot'>) {
  return getContextKey(context.workspaceRoot, context.pkgPath)
}

async function getManifestSignature(pkgPath: string) {
  return createHash('sha256').update(await fsp.readFile(pkgPath, 'utf8')).digest('hex')
}

async function isManifestSnapshotCurrent(context: PackageContext) {
  if (context.manifestSignature !== await getManifestSignature(context.pkgPath))
    return false
  if (context.rootManifestPath && context.rootManifestSignature !== await getManifestSignature(context.rootManifestPath))
    return false
  return true
}

function nextGeneration(key: string) {
  const generation = ++generationSequence
  generations.set(key, generation)
  return generation
}

function applyContext(context: PackageContext) {
  cacheMap.clear()
  for (const [key, value] of context.cacheMap)
    cacheMap.set(key, value)
}

function touchContext(contextKey: string, context: PackageContext) {
  contexts.delete(contextKey)
  contexts.set(contextKey, context)
}

function disposePackageWatcher(contextKey: string, pkgPath: string) {
  const watcher = mainWatchers.get(pkgPath)
  if (!watcher)
    return
  watcher.subscribers.delete(contextKey)
  if (watcher.subscribers.size)
    return
  try { watcher.stop() }
  catch {}
  mainWatchers.delete(pkgPath)
}

function registerPackageWatchers(contextKey: string, context: PackageContext, onChange: () => void) {
  try {
    let watcher = mainWatchers.get(context.pkgPath)
    if (!watcher) {
      const subscribers = new Map<string, () => void>()
      watcher = {
        subscribers,
        stop: watchFile(context.pkgPath, {
          onChange: () => {
            for (const rebuild of [...subscribers.values()])
              rebuild()
          },
        }),
      }
      mainWatchers.set(context.pkgPath, watcher)
    }
    watcher.subscribers.set(contextKey, onChange)

    const cached = rootPkgCache.get(context.workspaceRoot)
    if (!cached || cached.rootPkgPath === context.pkgPath)
      return
    cached.subscribers ||= new Map()
    cached.subscribers.set(contextKey, onChange)
    const rebuildSubscribers = () => {
      for (const rebuild of [...(cached.subscribers?.values() || [])])
        rebuild()
    }
    if (!cached.stopRoot) {
      cached.stopRoot = watchFile(cached.rootPkgPath, {
        onChange: rebuildSubscribers,
      })
    }
    if (!cached.stopWorkspace) {
      try {
        const fsWatcher = fs.watch(context.workspaceRoot, (_event, filename) => {
          if (filename?.toString() !== 'pnpm-workspace.yaml')
            return
          cached.isMonorepo = false
          rebuildSubscribers()
        })
        cached.stopWorkspace = () => fsWatcher.close()
      }
      catch {}
    }
  }
  catch (error) {
    disposePackageWatcher(contextKey, context.pkgPath)
    removeRootPackageSubscriber(contextKey)
    throw error
  }
}

function disposeUnusedWorkspaceResources(workspaceRoot: string) {
  const resolvedRoot = path.resolve(workspaceRoot)
  if ([...contexts.values()].some(context => path.resolve(context.workspaceRoot) === resolvedRoot)
    || [...contextLoads.values()].some(load => path.resolve(load.workspaceRoot) === resolvedRoot)) {
    return
  }
  disposeRootPackageCache(workspaceRoot)
  const prefix = `${resolvedRoot}\0`
  for (const [key, watcher] of localSourceWatchers) {
    if (!key.startsWith(prefix))
      continue
    if (watcher.timer)
      clearTimeout(watcher.timer)
    try { watcher.stop() }
    catch {}
    localSourceWatchers.delete(key)
  }
}

function pruneInactiveContexts() {
  if (contexts.size <= maxInactivePackageContexts)
    return
  const referenced = new Set(documentContextCache.values())
  for (const [contextKey, context] of contexts) {
    if (contexts.size <= maxInactivePackageContexts)
      break
    if (referenced.has(contextKey))
      continue
    const { workspaceRoot, pkgPath } = context
    contexts.delete(contextKey)
    contextLoads.delete(contextKey)
    generations.delete(contextKey)
    disposePackageWatcher(contextKey, pkgPath)
    removeRootPackageSubscriber(contextKey)
    if (workspaceRoot)
      disposeUnusedWorkspaceResources(workspaceRoot)
    for (const [documentPath, cached] of urlCache) {
      if (cached.pkg === pkgPath)
        urlCache.delete(documentPath)
    }
  }
}

export function releaseDocumentContext(documentPath: string) {
  documentPackageCache.delete(documentPath)
  documentContextCache.delete(documentPath)
  urlCache.delete(documentPath)
  pruneInactiveContexts()
}

export function getContextRegistryStats() {
  return {
    contexts: contexts.size,
    documents: documentPackageCache.size,
    watchers: mainWatchers.size,
    rootWorkspaces: rootPkgCache.size,
    localWatchers: localSourceWatchers.size,
  }
}

export function getContextForDocumentPath(cwd: string) {
  const contextKey = documentContextCache.get(cwd)
  return contextKey ? contexts.get(contextKey) : undefined
}

export function getContextForPackagePath(pkgPath: string, workspaceRoot?: string) {
  if (workspaceRoot)
    return contexts.get(getContextKey(workspaceRoot, pkgPath))
  return [...contexts.values()].find(context => context.pkgPath === pkgPath)
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
      documentContextCache.delete(documentPath)
      urlCache.delete(documentPath)
    }
  }
}

/**
 * Handle discovery-level package.json create/delete events without treating every
 * nested manifest as a change to its parent package. Precise package/root watchers
 * own normal rebuilds; this global path only invalidates an exact known package or
 * document mappings for which the changed manifest is a nearer package boundary.
 */
export function handlePackageManifestLifecycle(manifestPath: string) {
  const normalizedManifest = path.resolve(manifestPath)
  const manifestDirectory = path.dirname(normalizedManifest)
  const packagePaths: string[] = []
  const documentPaths: string[] = []

  const rootEntry = [...rootPkgCache.entries()].find(([, value]) => path.resolve(value.rootPkgPath) === normalizedManifest)
  if (rootEntry) {
    packagePaths.push(...[...contexts.values()]
      .filter(context => isSameOrWithin(path.dirname(context.pkgPath), rootEntry[0]))
      .map(context => context.pkgPath))
    invalidatePackageContext(rootEntry[0])
  }
  else if ([...contexts.values()].some(context => context.pkgPath === normalizedManifest)
    || [...contextLoads.values()].some(load => load.pkgPath === normalizedManifest)) {
    packagePaths.push(normalizedManifest)
    invalidatePackageContext(normalizedManifest)
  }

  for (const [documentPath, packagePath] of [...documentPackageCache]) {
    const currentDirectory = packagePath ? path.dirname(packagePath) : undefined
    const mappedToChangedManifest = packagePath === normalizedManifest
    const introducesNearerBoundary = !!currentDirectory
      && normalizedManifest !== packagePath
      && isSameOrWithin(manifestDirectory, currentDirectory)
      && isSameOrWithin(documentPath, manifestDirectory)
    if (!mappedToChangedManifest && !introducesNearerBoundary)
      continue
    documentPackageCache.delete(documentPath)
    documentContextCache.delete(documentPath)
    urlCache.delete(documentPath)
    documentPaths.push(documentPath)
  }

  return { packagePaths, documentPaths }
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

  const resolvedWorkspaceRoot = workspaceRoot || path.dirname(pkgPath)
  const contextKey = getContextKey(resolvedWorkspaceRoot, pkgPath)
  const existing = contexts.get(contextKey)
  if (existing) {
    touchContext(contextKey, existing)
    documentPackageCache.set(cwd, pkgPath)
    documentContextCache.set(cwd, contextKey)
    applyContext(existing)
    revalidateStaleContext(existing, extensionContext, detectSlots, resolvedWorkspaceRoot)
    return existing
  }
  const loading = contextLoads.get(contextKey)
  if (loading) {
    const context = await loading.task
    if (context && contexts.get(contextKey) === context && generations.get(contextKey) === context.generation) {
      documentPackageCache.set(cwd, pkgPath)
      documentContextCache.set(cwd, contextKey)
    }
    return context
  }

  const epoch = registryEpoch
  const generation = nextGeneration(contextKey)
  const load = {} as ContextLoad
  load.epoch = epoch
  load.generation = generation
  load.pkgPath = pkgPath
  load.workspaceRoot = resolvedWorkspaceRoot
  load.task = (async () => {
    try {
      let context = await buildContext(cwd, extensionContext, detectSlots, generation, resolvedWorkspaceRoot)
      let manifestBuildAttempts = 1
      while (context) {
        if (registryEpoch !== epoch || generations.get(contextKey) !== generation)
          return
        const onChange = () => {
          invalidatePackageContext(contextKey, true)
          void ensureContextForPath(cwd, extensionContext, detectSlots, false, resolvedWorkspaceRoot)
            .catch(error => logger.error(`Failed to rebuild package context: ${String(error)}`))
        }
        registerPackageWatchers(contextKey, context, onChange)
        let manifestSnapshotCurrent: boolean
        try {
          manifestSnapshotCurrent = await isManifestSnapshotCurrent(context)
        }
        catch (error) {
          disposePackageWatcher(contextKey, context.pkgPath)
          removeRootPackageSubscriber(contextKey)
          throw error
        }
        if (registryEpoch !== epoch || generations.get(contextKey) !== generation) {
          disposePackageWatcher(contextKey, context.pkgPath)
          removeRootPackageSubscriber(contextKey)
          return
        }
        if (manifestSnapshotCurrent)
          break
        disposePackageWatcher(contextKey, context.pkgPath)
        removeRootPackageSubscriber(contextKey)
        urlCache.delete(cwd)
        clearPackageVersionCache()
        clearTypeCache()
        if (manifestBuildAttempts++ >= 3)
          throw new Error(`Package manifest kept changing while loading: ${context.pkgPath}`)
        context = await buildContext(cwd, extensionContext, detectSlots, generation, resolvedWorkspaceRoot, true)
      }
      if (!context || registryEpoch !== epoch || generations.get(contextKey) !== generation)
        return
      touchContext(contextKey, context)
      documentPackageCache.set(cwd, context.pkgPath)
      documentContextCache.set(cwd, contextKey)
      pruneInactiveContexts()
      applyContext(context)
      notifyContextUpdated(context)
      startTrackedContextEnhancements(context, epoch)
      return context
    }
    finally {
      if (contextLoads.get(contextKey) === load)
        contextLoads.delete(contextKey)
      disposeUnusedWorkspaceResources(resolvedWorkspaceRoot)
    }
  })()
  contextLoads.set(contextKey, load)
  return load.task
}

function maybeStartCustomRefresh(context: PackageContext, expectedEpoch: number, now = Date.now()) {
  const contextKey = getContextKeyForContext(context)
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
  startTrackedContextEnhancements(latest, expectedEpoch)
  return true
}

function revalidateStaleContext(context: PackageContext, extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, workspaceRoot: string) {
  const contextKey = getContextKeyForContext(context)
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
      refreshed.customSourceSnapshots = new Map(await Promise.all([...registered.customSourceSnapshots].map(async ([sourceId, snapshot]) => [
        sourceId,
        snapshot.reductionSignature === getCustomReductionSignature(refreshed)
          ? snapshot
          : await prepareCustomSnapshot(refreshed, sourceId, snapshot.exports, snapshot.signature, snapshot.configurationIndex),
      ] as const)))
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
  const discovered = (!refreshDiscovery && urlCache.get(cwd)) || await findPkgUI(cwd, undefined, workspaceRoot)
  if (!discovered)
    return
  urlCache.set(cwd, discovered)
  const { pkg, uis } = discovered
  const context = await buildCompletions(uis, {
    selectedUIs: getSelectedUIs(pkg, workspaceRoot) || [],
    alias: getAlias(pkg, workspaceRoot) || {},
    detectSlots,
    prefix: getPrefix(pkg, workspaceRoot) || {},
    pkgPath: pkg,
    workspaceRoot,
  }, cwd, generation)
  context.manifestSignature = discovered.manifestSignature
  context.rootManifestPath = discovered.rootManifestPath
  context.rootManifestSignature = discovered.rootManifestSignature
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
  const pkgPath = options.pkgPath || cwd
  const workspaceRoot = options.workspaceRoot || path.dirname(pkgPath)
  const contextKey = getContextKey(workspaceRoot, pkgPath)
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
  const adapterRuntimeOptions = new Map<string, AdapterRuntimeOptions>()
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
      const resolvedVersion = await resolveInstalledPackageVersion(underlyingPackageName, path.dirname(pkgPath))
      const validResolvedVersion = resolvedVersion && semver.valid(resolvedVersion)
      installedVersion = validResolvedVersion && (!parsedAlias.major || semver.major(validResolvedVersion) === Number(parsedAlias.major))
        ? validResolvedVersion
        : undefined
      uiName = underlyingPackageName
      originNames.push(`${declaredName}${major}`)
    }
    else {
      originNames.push(`${declaredName}${major}`)
    }
    const formatName = `${formatUIName(uiName)}${major}`
    const selectionName = `${declaredName}${major}`
    formatToPkg.set(formatName, { pkgName: uiName, version: major, installedVersion, adapterMajor: major })
    const runtimeOptions = { resolveFrom: pkgPath, installedVersion, adapterMajor: major }
    adapterRuntimeOptions.set(formatName, runtimeOptions)
    adapterRuntimeOptions.set(selectionName, runtimeOptions)
    adapterRuntimeOptions.set(formatUIName(uiName), runtimeOptions)
    adapterRuntimeOptions.set(formatUIName(declaredName), runtimeOptions)
    selectionToAdapter.set(formatName, formatName)
    selectionToAdapter.set(selectionName, formatName)
    if (declaredName === '@dcloudio/uni-ui')
      selectionToAdapter.set('dcloudioUniUi', formatName)
    availableNames.push(formatName)
    adapterSources.set(formatName, [...(adapterSources.get(formatName) || []), declaredName, uiName])
  }

  const hasExplicitSelection = Array.isArray(selectedUIs) && !selectedUIs.includes('auto')
  const selected = hasExplicitSelection
    ? selectedUIs.map(item => selectionToAdapter.get(legacySelectionAliases[item] || item)).filter((item): item is string => !!item)
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
      const components = exports[componentsKey]?.({ resolveFrom: pkgPath, installedVersion: pkgInfo?.installedVersion, adapterMajor: pkgInfo?.adapterMajor })
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
    customSourceEpoch: 0,
    customRefreshPending: false,
    uiNames,
    currentPkgUiNames: availableNames,
    userPrefix,
    adapterRuntimeOptions,
    ...cloneModel(officialModel),
    officialModel,
    customSourceSnapshots: new Map(),
  }
}

function getConfiguredLocalSourcePaths(workspaceRoot: string) {
  const root = path.resolve(workspaceRoot)
  const uris = getConfiguration('common-intellisense.localUris') as unknown
  if (!Array.isArray(uris))
    return []
  return uris
    .filter((uri): uri is string => typeof uri === 'string' && !!uri.trim())
    .map(uri => path.resolve(root, uri))
    .filter(sourcePath => sourcePath !== root && isSameOrWithin(sourcePath, root))
}

async function getConfiguredLocalSources(workspaceRoot: string) {
  const configuredPaths = getConfiguredLocalSourcePaths(workspaceRoot)
  const resolved = await Promise.all(configuredPaths.map(async configuredPath => ({
    configuredPath,
    resolvedPath: await resolveLocalAdapterFile(workspaceRoot, configuredPath, { allowMissing: true }),
  })))
  return resolved.filter((source): source is { configuredPath: string, resolvedPath: string } => !!source.resolvedPath)
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
      customSourceEpoch: current.customSourceEpoch + 1,
      customRefreshPending: false,
      customSourceSnapshots: new Map(),
    }
    contexts.set(contextKey, reset)
    notifyContextUpdated(reset)
    startTrackedContextEnhancements(reset, expectedEpoch)
  }
}

export async function handleLocalSourceChanged(workspaceRoot: string, sourcePath: string) {
  const resolvedSource = path.resolve(sourcePath)
  if (!getConfiguredLocalSourcePaths(workspaceRoot).includes(resolvedSource))
    return
  const sourceId = `local:${resolvedSource}`
  const exists = !!(await resolveLocalAdapterFile(workspaceRoot, resolvedSource))
  for (const context of [...contexts.values()]) {
    if (path.resolve(context.workspaceRoot) !== path.resolve(workspaceRoot))
      continue
    context.customSourcesCheckedAt = 0
    context.customNextRetryAt = 0
    context.customSourceEpoch++
    const customKey = getSourceRefreshKey('custom', context)
    const customRefreshRunning = sourceRefreshes.has(customKey)
    context.customRefreshPending = customRefreshRunning
    if (!exists && context.customSourceSnapshots.has(sourceId)) {
      const snapshots = new Map(context.customSourceSnapshots)
      snapshots.delete(sourceId)
      await publishContextEnhancement(context, registryEpoch, snapshots, context.customSourceEpoch)
      if (!customRefreshRunning)
        context.customRefreshPending = false
      continue
    }
    const officialKey = getSourceRefreshKey('official', context)
    if (!sourceRefreshes.has(officialKey))
      startTrackedContextEnhancements(context, registryEpoch)
  }
}

async function ensureLocalSourceWatchers(context: PackageContext, expectedEpoch: number) {
  const configuredSources = await getConfiguredLocalSources(context.workspaceRoot)
  const contextKey = getContextKeyForContext(context)
  const isContextLive = () => registryEpoch === expectedEpoch
    && contexts.get(contextKey)?.generation === context.generation
  if (!isContextLive())
    return
  const rootPrefix = `${path.resolve(context.workspaceRoot)}\0`
  for (const [key, entry] of localSourceWatchers) {
    if (key.startsWith(rootPrefix) && !configuredSources.some(source => key === `${rootPrefix}${source.configuredPath}`)) {
      entry.stop()
      if (entry.timer)
        clearTimeout(entry.timer)
      localSourceWatchers.delete(key)
    }
  }
  for (const { configuredPath, resolvedPath } of configuredSources) {
    if (!isContextLive())
      return
    const key = `${path.resolve(context.workspaceRoot)}\0${configuredPath}`
    if (localSourceWatchers.has(key))
      continue
    const entry: { stop: () => void, timer?: ReturnType<typeof setTimeout> } = { stop: () => {} }
    const scheduleRefresh = () => {
      if (entry.timer)
        clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        void handleLocalSourceChanged(context.workspaceRoot, configuredPath).catch(error => logger.error(`local source refresh failed: ${String(error)}`))
      }, 200)
    }
    const stops: Array<() => void> = []
    for (const watchPath of new Set([configuredPath, resolvedPath])) {
      stops.push(watchFile(watchPath, { onChange: scheduleRefresh, onDelete: scheduleRefresh }))
      const createWatcher = vscode.workspace.createFileSystemWatcher?.(watchPath, false, true, true)
      if (createWatcher) {
        const createSubscription = createWatcher.onDidCreate(scheduleRefresh)
        stops.push(() => {
          createSubscription.dispose()
          createWatcher.dispose()
        })
      }
    }
    entry.stop = () => stops.forEach(stop => stop())
    localSourceWatchers.set(key, entry)
  }
}

function startTrackedContextEnhancements(context: PackageContext, expectedEpoch: number) {
  void ensureLocalSourceWatchers(context, expectedEpoch).catch(error => logger.error(`local source watcher setup failed: ${String(error)}`))
  const refreshKey = getSourceRefreshKey('custom', context)
  if (sourceRefreshes.has(refreshKey))
    return
  context.customLastAttemptAt = Date.now()
  context.customNextRetryAt = context.customLastAttemptAt + sourceRetryDelays[0]
  context.customRefreshPending = false
  const expectedSourceEpoch = context.customSourceEpoch
  sourceRefreshes.add(refreshKey)
  startContextEnhancements(context, expectedEpoch, expectedSourceEpoch, () => {
    sourceRefreshes.delete(refreshKey)
    const latest = contexts.get(getContextKeyForContext(context))
    if (latest?.generation === context.generation
      && latest.customSourceEpoch !== expectedSourceEpoch
      && latest.customRefreshPending) {
      latest.customRefreshPending = false
      startTrackedContextEnhancements(latest, registryEpoch)
    }
  })
}

function getAdapterRuntimeOptions(context: PackageContext, exportKey: string) {
  const baseKey = exportKey.replace(/Components$/, '')
  return context.adapterRuntimeOptions.get(baseKey)
    || context.adapterRuntimeOptions.get(formatUIName(baseKey))
    || { resolveFrom: context.pkgPath }
}

function getCustomReductionSignature(context: PackageContext) {
  let locale = ''
  try { locale = getLocale() }
  catch {}
  return JSON.stringify({
    adapterRuntimeOptions: [...context.adapterRuntimeOptions].sort(([a], [b]) => a.localeCompare(b)),
    userPrefix: Object.keys(context.userPrefix).sort().map(key => [key, context.userPrefix[key]]),
    locale,
    workspaceRoot: path.resolve(context.workspaceRoot),
    pkgPath: path.resolve(context.pkgPath),
  })
}

async function prepareCustomSnapshot(context: PackageContext, sourceId: string, exports: Record<string, any>, signature: string, configurationIndex = Number.MAX_SAFE_INTEGER): Promise<CustomSourceSnapshot> {
  const reductionSignature = getCustomReductionSignature(context)
  const model: ContextModel = { optionsComponents: emptyOptions(), uiCompletions: null, cacheMap: new Map(), sourceScopes: new Map(), sourceSignatures: new Map([[sourceId, signature]]) }
  for (const key of Object.keys(exports)) {
    const scopedKey = `custom:${sourceId}:${key}`
    if (key.endsWith('Components')) {
      const components = exports[key]?.(getAdapterRuntimeOptions(context, key))
      if (components) {
        model.cacheMap.set(scopedKey, components)
        const directiveKey = `custom:${sourceId}:${key.slice(0, -'Components'.length)}`
        mergeComponents(model.optionsComponents, components, context.userPrefix, [], directiveKey, scopedKey, sourceId, signature)
      }
      continue
    }
    const completion = await exports[key]?.(getAdapterRuntimeOptions(context, key))
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
  return { exports, signature, reductionSignature, configurationIndex, model }
}

function startContextEnhancements(context: PackageContext, expectedEpoch: number, expectedSourceEpoch: number, onSettled?: () => void) {
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
          if (old && result.signature && old.signature === result.signature && old.reductionSignature === getCustomReductionSignature(context)) {
            const configurationIndex = result.configurationIndex ?? Number.MAX_SAFE_INTEGER
            preparedPrefix.set(result.id, old.configurationIndex === configurationIndex ? old : { ...old, configurationIndex })
          }
          else {
            try {
              preparedPrefix.set(result.id, await prepareCustomSnapshot(context, result.id, result.value || {}, signature, result.configurationIndex))
            }
            catch {
              loaderFailed = true
              if (old)
                preparedPrefix.set(result.id, old)
              logger.error(`custom source reduction failed [${prefix}:${result.configurationIndex ?? 'unknown'}]`)
            }
          }
        }
        else {
          if (old)
            preparedPrefix.set(result.id, old)
          loaderFailed = true
          logger.error(`custom source failed [${prefix}:${result.configurationIndex ?? 'unknown'}]`)
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
          const published = await publishContextEnhancement(context, expectedEpoch, new Map(next), expectedSourceEpoch)
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
      const current = contexts.get(getContextKeyForContext(context))
      if (!loaderFailed
        && !publicationFailed
        && registryEpoch === expectedEpoch
        && current?.generation === context.generation
        && current.customSourceEpoch === expectedSourceEpoch
        && current.officialCheckedAt === context.officialCheckedAt) {
        current.customSourcesCheckedAt = Date.now()
        current.customFailureCount = 0
        current.customNextRetryAt = 0
      }
      else if (registryEpoch === expectedEpoch
        && current?.generation === context.generation
        && current.customSourceEpoch === expectedSourceEpoch
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
  const orderedSnapshots = [...snapshotCopy.entries()].sort(([a, left], [b, right]) => sourceOrder(a) - sourceOrder(b)
    || left.configurationIndex - right.configurationIndex
    || a.localeCompare(b))
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

async function publishContextEnhancement(context: PackageContext, expectedEpoch: number, sourceResults: CustomSourceSnapshots, expectedSourceEpoch = context.customSourceEpoch) {
  if (registryEpoch !== expectedEpoch)
    return
  const contextKey = getContextKeyForContext(context)
  const current = contexts.get(contextKey)
  const latestGeneration = generations.get(contextKey) ?? generations.get(context.cwd)
  if (!current || current.generation !== context.generation || current.customSourceEpoch !== expectedSourceEpoch || current.officialCheckedAt !== context.officialCheckedAt || latestGeneration !== context.generation)
    return

  const enhanced = await composeContextFromSnapshots(context, sourceResults)
  const registered = contexts.get(contextKey)
  const generation = generations.get(contextKey) ?? generations.get(context.cwd)
  if (registryEpoch !== expectedEpoch || registered !== current || registered.generation !== context.generation || registered.customSourceEpoch !== expectedSourceEpoch || registered.officialCheckedAt !== context.officialCheckedAt || generation !== context.generation)
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
    const renderedPrefix = Object.prototype.hasOwnProperty.call(userPrefix || {}, lib) ? userPrefix[lib] : undefined
    if (renderedPrefix !== undefined)
      prefix = renderedPrefix
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
    target.data.push(...providers.map((provider: any) => (parent: any, context: any) => provider(parent, {
      ...context,
      ...(renderedPrefix !== undefined ? { renderedPrefix } : {}),
      ...(completionSourceId ? { sourceId: completionSourceId, sourceSignature } : {}),
    })))
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

export function parseAlias(value: string) {
  const trimmed = value?.trim() || ''
  const major = trimmed.match(/\d+$/)?.[0]
  if (!major)
    return { name: undefined, major: undefined }
  const prefix = trimmed.slice(0, -major.length)
  const name = (prefix.endsWith('^') ? prefix.slice(0, -1) : prefix).trim()
  return { name: name || undefined, major: name ? major : undefined }
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

export async function findPkgUI(cwd?: string, _onChange?: () => void, workspaceRoot?: string) {
  if (!cwd)
    return
  const pkg = await findUp('package.json', { cwd })
  if (!pkg)
    return
  const pkgDir = path.dirname(pkg)
  let rootPkgPath = ''
  let rootPkg: any = null
  let rootManifestSignature: string | undefined
  let isMonorepo = false
  const rootPath = workspaceRoot || getRootPath()
  const alias = getAlias(pkg, rootPath) || {}
  if (rootPath) {
    const cached = rootPkgCache.get(rootPath)
    if (cached) {
      ({ rootPkgPath, rootPkg, isMonorepo } = cached)
      // A root package watcher may have fired since this entry was created.
      // Re-read the small manifest so dependency changes cannot reuse stale data.
      if (rootPkgPath && rootPkgPath !== pkg) {
        try {
          const rootManifestText = await fsp.readFile(rootPkgPath, 'utf8')
          rootManifestSignature = createHash('sha256').update(rootManifestText).digest('hex')
          rootPkg = JSON.parse(rootManifestText)
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
          const rootManifestText = await fsp.readFile(rootPkgPath, 'utf8')
          rootManifestSignature = createHash('sha256').update(rootManifestText).digest('hex')
          rootPkg = JSON.parse(rootManifestText)
          isMonorepo = await computeMonorepoState(rootPath, rootPkg)
        }
        catch {}
      }
      rootPkgCache.set(rootPath, { rootPkgPath, rootPkg, isMonorepo, subscribers: new Map() })
    }
  }

  const manifestText = await fsp.readFile(pkg, 'utf8')
  const manifestSignature = createHash('sha256').update(manifestText).digest('hex')
  const manifest = JSON.parse(manifestText)
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
  return {
    pkg,
    uis: result,
    manifestSignature,
    ...(dependencyRootPkg && rootManifestSignature
      ? { rootManifestPath: rootPkgPath, rootManifestSignature }
      : {}),
  }
}

function isSameOrWithin(target: string, parent: string) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function invalidatePackageContext(cwdOrPkg: string, retainWorkspaceResources = false) {
  const affected = new Map<string, { pkgPath: string, workspaceRoot: string }>()
  const cachedContextKey = documentContextCache.get(cwdOrPkg)
  const exactContextKey = cwdOrPkg.includes('\0')

  for (const [contextKey, context] of contexts) {
    const root = path.dirname(context.pkgPath)
    if (contextKey === cwdOrPkg || contextKey === cachedContextKey || (!exactContextKey && (context.pkgPath === cwdOrPkg || isSameOrWithin(cwdOrPkg, root) || isSameOrWithin(root, cwdOrPkg))))
      affected.set(contextKey, context)
  }
  for (const [contextKey, load] of contextLoads) {
    const root = path.dirname(load.pkgPath)
    if (contextKey === cwdOrPkg || contextKey === cachedContextKey || (!exactContextKey && (load.pkgPath === cwdOrPkg || isSameOrWithin(cwdOrPkg, root) || isSameOrWithin(root, cwdOrPkg))))
      affected.set(contextKey, load)
  }

  const affectedPackages = new Set([...affected.values()].map(item => item.pkgPath))
  const affectedWorkspaceRoots = new Set<string>()
  for (const [contextKey, item] of affected) {
    nextGeneration(contextKey)
    affectedWorkspaceRoots.add(item.workspaceRoot)
    contexts.delete(contextKey)
    contextLoads.delete(contextKey)
    disposePackageWatcher(contextKey, item.pkgPath)
    removeRootPackageSubscriber(contextKey)
  }
  if (!retainWorkspaceResources) {
    for (const workspaceRoot of affectedWorkspaceRoots)
      disposeUnusedWorkspaceResources(workspaceRoot)
  }
  for (const [documentPath, packagePath] of documentPackageCache) {
    const mappedContextKey = documentContextCache.get(documentPath)
    if (packagePath && (affected.has(mappedContextKey || '') || (!exactContextKey && (affectedPackages.has(packagePath) || isSameOrWithin(documentPath, cwdOrPkg))))) {
      documentPackageCache.delete(documentPath)
      documentContextCache.delete(documentPath)
    }
  }
  for (const key of urlCache.keys()) {
    const cached = urlCache.get(key)
    if ((!exactContextKey && isSameOrWithin(key, cwdOrPkg)) || (cached && affectedPackages.has(cached.pkg) && documentContextCache.get(key) === undefined))
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
  documentContextCache.clear()
  urlCache.clear()
  cacheMap.clear()
  pkgUIConfigMap.clear()
  clearPackageVersionCache()
  clearTypeCache()
  notifyContextInvalidated()
}

export function disposeUIWatchers() {
  for (const watcher of mainWatchers.values()) {
    try { watcher.stop() }
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

export function deactivateUICache() {
  disposeUIWatchers()
  invalidateContexts()
  contextInvalidationListeners.clear()
  contextUpdateListeners.clear()
  deactivateCache()
}

export { getCacheMap, urlCache }
