import type * as vscode from 'vscode'
import type { OptionsComponents, PropsConfig, Uis } from './types'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createLog, getCurrentFileUrl, getRootPath, watchFile } from '@vscode-use/utils'
import { findUp } from 'find-up'
import { UINames as configUINames } from '../constants'
import { fetchFromCommonIntellisense, fetchFromLocalUris, fetchFromRemoteNpmUrls, fetchFromRemoteUrls, getLocalCache, writeLocalCache } from '../services/fetch'
import { clearPackageVersionCache, resolveInstalledPackageVersion } from '../services/package-version'
import { cacheMap, deactivateUICache as deactivateCache, getCacheMap, pkgUIConfigMap, rootPkgCache, urlCache } from '../services/ui-cache'
import { clearTypeCache } from '../type-extract/cache'
import { formatUIName, getAlias, getPrefix, getSelectedUIs } from './ui-utils'

export const logger = createLog('common-intellisense')

export interface PackageContext {
  cwd: string
  pkgPath: string
  generation: number
  uiNames: string[]
  currentPkgUiNames: string[]
  optionsComponents: OptionsComponents
  uiCompletions: PropsConfig | null
  cacheMap: Map<string, any>
}

const contexts = new Map<string, PackageContext>()
const contextLoads = new Map<string, Promise<PackageContext | undefined>>()
const generations = new Map<string, number>()
const documentPackageCache = new Map<string, string | null>()
const mainWatchers = new Map<string, () => void>()
let registryEpoch = 0
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
  return { prefix: [], data: [], directivesMap: {}, libs: [] }
}

function nextGeneration(key: string) {
  const generation = (generations.get(key) || 0) + 1
  generations.set(key, generation)
  return generation
}

function applyContext(context: PackageContext) {
  activeContext = context
  cacheMap.clear()
  for (const [key, value] of context.cacheMap)
    cacheMap.set(key, value)
}

export function getContextForDocumentPath(cwd: string) {
  const packagePath = documentPackageCache.get(cwd)
  return packagePath ? contexts.get(packagePath) : contexts.get(cwd)
}

export async function ensureContextForPath(cwd: string, extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, cleanCache = false) {
  if (!cwd || cwd === 'exthhost')
    return
  if (cleanCache)
    invalidateContexts()

  let pkgPath = documentPackageCache.get(cwd)
  if (pkgPath === undefined) {
    pkgPath = await findUp('package.json', { cwd }) || null
    documentPackageCache.set(cwd, pkgPath)
  }
  if (!pkgPath)
    return

  const existing = contexts.get(pkgPath)
  if (existing) {
    applyContext(existing)
    return existing
  }
  const loading = contextLoads.get(pkgPath)
  if (loading)
    return loading

  const epoch = registryEpoch
  const generation = nextGeneration(pkgPath)
  const task = buildContext(cwd, extensionContext, detectSlots, generation)
  contextLoads.set(pkgPath, task)
  try {
    const context = await task
    if (!context || registryEpoch !== epoch || generations.get(pkgPath) !== generation)
      return
    contexts.set(context.pkgPath, context)
    documentPackageCache.set(cwd, context.pkgPath)
    applyContext(context)
    notifyContextUpdated(context)
    return context
  }
  finally {
    if (contextLoads.get(pkgPath) === task)
      contextLoads.delete(pkgPath)
  }
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

async function buildContext(cwd: string, extensionContext: vscode.ExtensionContext, detectSlots: (...args: any[]) => void, generation: number) {
  const onChange = () => {
    invalidatePackageContext(cwd)
    void ensureContextForPath(cwd, extensionContext, detectSlots)
  }
  const discovered = urlCache.get(cwd) || await findPkgUI(cwd, onChange)
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
}

export async function updateCompletions(uis: Uis, options: UpdateCompletionsOptions) {
  const cwd = options.pkgPath ? path.dirname(options.pkgPath) : getCurrentFileUrl() || ''
  const context = await buildCompletions(uis, options, cwd, nextGeneration(cwd))
  contexts.set(cwd, context)
  applyContext(context)
  contextUpdateListeners.forEach(listener => listener(context))
  return context
}

async function buildCompletions(uis: Uis, options: UpdateCompletionsOptions, cwd: string, generation: number): Promise<PackageContext> {
  const { selectedUIs, alias, prefix: userPrefix, pkgPath = '' } = options
  await getLocalCache
  const localCache = new Map<string, any>()
  const localUI: Record<string, () => any> = {}
  const localOptions = emptyOptions()
  let localCompletions: PropsConfig | null = null
  const availableNames: string[] = []
  const originNames: string[] = []
  const formatToPkg = new Map<string, { pkgName: string, version: string }>()
  const selectionToAdapter = new Map<string, string>()

  for (const [declaredName, version] of uis) {
    let uiName = declaredName
    let major = extractMajor(version) || '0'
    if (uiName in alias) {
      const parsedAlias = parseAlias(alias[uiName])
      uiName = parsedAlias.name || uiName
      major = parsedAlias.major || major
      originNames.push(`${declaredName}${major}`)
    }
    else {
      originNames.push(`${declaredName}${major}`)
    }
    const formatName = `${formatUIName(uiName)}${major}`
    const selectionName = `${declaredName}${major}`
    formatToPkg.set(formatName, { pkgName: uiName, version: major })
    selectionToAdapter.set(formatName, formatName)
    selectionToAdapter.set(selectionName, formatName)
    availableNames.push(formatName)
  }

  const hasExplicitSelection = !!selectedUIs?.length && !selectedUIs.includes('auto')
  const selected = hasExplicitSelection
    ? selectedUIs.map(item => selectionToAdapter.get(item)).filter((item): item is string => !!item)
    : []
  const uiNames = hasExplicitSelection ? [...new Set(selected)] : availableNames

  await loadOtherSources(localUI, localCache, localOptions, path.dirname(pkgPath), () => localCompletions, value => localCompletions = value)

  // Deliberately sequential: configured library order defines collision precedence.
  for (const name of uiNames) {
    try {
      const pkgInfo = formatToPkg.get(name)
      const exports = await fetchFromCommonIntellisense(
        name.replace(/([A-Z])/g, '-$1').toLowerCase(),
        pkgInfo ? { pkgName: pkgInfo.pkgName, uiName: name, resolveFrom: pkgPath } : { uiName: name, resolveFrom: pkgPath },
      )
      if (exports)
        Object.assign(localUI, exports)
      const componentsKey = `${name}Components`
      const components = localUI[componentsKey]?.()
      if (components) {
        localCache.set(componentsKey, components)
        mergeComponents(localOptions, components, userPrefix, originNames, name)
      }
      const completion = await localUI[name]?.()
      if (completion) {
        localCache.set(name, completion)
        localCompletions ||= {} as PropsConfig
        Object.assign(localCompletions, completion)
      }
    }
    catch (error) {
      logger.error(`fetch fetchFromCommonIntellisense [${name}] error: ${String(error)}`)
    }
  }

  await writeLocalCache()

  return { cwd, pkgPath, generation, uiNames, currentPkgUiNames: availableNames, optionsComponents: localOptions, uiCompletions: localCompletions, cacheMap: localCache }
}

async function loadOtherSources(
  ui: Record<string, () => any>,
  targetCache: Map<string, any>,
  targetOptions: OptionsComponents,
  workspaceRoot: string,
  getCompletions: () => PropsConfig | null,
  setCompletions: (value: PropsConfig) => void,
) {
  const loaders = [
    () => fetchFromLocalUris(workspaceRoot),
    fetchFromRemoteUrls,
    fetchFromRemoteNpmUrls,
  ]
  for (const loader of loaders) {
    try {
      const exports = await loader()
      if (!exports)
        continue
      Object.assign(ui, exports)
      for (const key of Object.keys(exports)) {
        try {
          if (key.endsWith('Components')) {
            const components = exports[key]?.()
            if (components) {
              targetCache.set(key, components)
              mergeComponents(targetOptions, components, {}, [], key.slice(0, -10))
            }
          }
          else {
            const completion = await exports[key]?.()
            if (completion) {
              targetCache.set(key, completion)
              const merged = getCompletions() || {} as PropsConfig
              Object.assign(merged, completion)
              setCompletions(merged)
            }
          }
        }
        catch (error) {
          logger.error(`custom source export [${key}] failed: ${String(error)}`)
        }
      }
    }
    catch (error) {
      logger.error(`custom source failed: ${String(error)}`)
    }
  }
}

function mergeComponents(target: OptionsComponents, components: any[], userPrefix: Record<string, string>, originNames: string[], fallbackName: string) {
  for (const component of components) {
    let { prefix, data, directives, lib } = component
    if (userPrefix?.[lib])
      prefix = userPrefix[lib]
    if (target.libs.includes(lib) && target.prefix.includes(prefix))
      continue
    target.libs.push(lib)
    if (!target.prefix.includes(prefix))
      target.prefix.push(prefix)
    target.data.push(data)
    const libWithVersion = originNames.find(item => item.startsWith(lib)) || fallbackName
    target.directivesMap[libWithVersion] = directives
  }
}

export interface ParsedDependency {
  packageName?: string
  major?: string
  requiresInstalledVersion: boolean
}

export function parseDeclaredDependency(spec: unknown): ParsedDependency {
  if (typeof spec !== 'string' || !spec.trim())
    return { requiresInstalledVersion: true }
  const value = spec.trim()
  if (/^(?:file|link|patch|git\+|https?|github|gitlab|bitbucket):/i.test(value) || /^(?:latest|next|beta|canary|\*)$/i.test(value))
    return { requiresInstalledVersion: true }
  if (value.startsWith('npm:')) {
    const match = value.slice(4).match(/^((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/)
    return { packageName: match?.[1], major: extractMajor(match?.[2]), requiresInstalledVersion: !extractMajor(match?.[2]) }
  }
  const protocol = value.match(/^(?:workspace|catalog|catelog):(.*)$/i)
  if (protocol) {
    const major = extractMajor(protocol[1])
    return { major, requiresInstalledVersion: !major }
  }
  const major = extractMajor(value)
  return { major, requiresInstalledVersion: !major }
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

export function selectDependencyVersion(installed: string | undefined, declaredMajor: string | undefined) {
  if (!installed)
    return declaredMajor
  const installedMajor = extractMajor(installed)
  return declaredMajor && installedMajor !== declaredMajor ? declaredMajor : installed
}

export async function findPkgUI(cwd?: string, onChange?: () => void) {
  const alias = getAlias() || {}
  if (!cwd)
    return
  const pkg = await findUp('package.json', { cwd })
  if (!pkg)
    return
  const pkgDir = path.dirname(pkg)
  let rootPkgPath = ''
  let rootPkg: any = null
  let isMonorepo = false
  const rootPath = getRootPath()
  if (rootPath) {
    const cached = rootPkgCache.get(rootPath)
    if (cached) {
      ({ rootPkgPath, rootPkg, isMonorepo } = cached)
      // A root package watcher may have fired since this entry was created.
      // Re-read the small manifest so dependency changes cannot reuse stale data.
      if (rootPkgPath && rootPkgPath !== pkg) {
        try {
          rootPkg = JSON.parse(await fsp.readFile(rootPkgPath, 'utf8'))
          isMonorepo = !!(rootPkg?.workspaces || rootPkg?.pnpm?.workspaces || isMonorepo)
          cached.rootPkg = rootPkg
          cached.isMonorepo = isMonorepo
        }
        catch {}
      }
    }
    else {
      rootPkgPath = path.resolve(rootPath, 'package.json')
      if (rootPkgPath !== pkg) {
        try {
          rootPkg = JSON.parse(await fsp.readFile(rootPkgPath, 'utf8'))
          isMonorepo = !!(rootPkg?.workspaces || rootPkg?.pnpm?.workspaces)
          if (!isMonorepo) {
            try { await fsp.access(path.resolve(rootPath, 'pnpm-workspace.yaml')); isMonorepo = true }
            catch {}
          }
        }
        catch {}
      }
      rootPkgCache.set(rootPath, { rootPkgPath, rootPkg, isMonorepo })
    }
  }

  if (onChange && !mainWatchers.has(pkg)) {
    const invalidate = () => {
      invalidatePackageContext(cwd)
      onChange()
    }
    mainWatchers.set(pkg, watchFile(pkg, { onChange: invalidate }))
    if (isMonorepo && rootPath && rootPkgPath && rootPkgPath !== pkg) {
      const cached = rootPkgCache.get(rootPath)!
      if (!cached.stopRoot) {
        cached.stopRoot = watchFile(rootPkgPath, {
          onChange: () => {
            invalidatePackageContext(rootPath)
            onChange()
          },
        })
      }
    }
  }

  const manifest = JSON.parse(await fsp.readFile(pkg, 'utf8'))
  const { localDependencies, dependencies: deps } = collectDependencyScopes(manifest, rootPkg)
  const aliasUiNames = Object.keys(alias)
  const result: Uis = []
  for (const key of Object.keys(deps)) {
    if (!configUINames.includes(key) && !aliasUiNames.includes(key))
      continue
    const declared = deps[key]
    const parsed = parseDeclaredDependency(declared)
    const resolveFrom = getDependencyResolveFrom(key, localDependencies, pkgDir, rootPath)
    const installedName = parsed.packageName || key
    const installed = await resolveInstalledPackageVersion(installedName, resolveFrom)
    const version = selectDependencyVersion(installed, parsed.major)
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
  contexts.clear()
  contextLoads.clear()
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
