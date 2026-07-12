import { Buffer } from 'node:buffer'
import dns from 'node:dns/promises'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import process from 'node:process'
import path from 'node:path'
import { isIP } from 'node:net'
import vm from 'node:vm'
import * as vscode from 'vscode'
import { fetchAndExtractPackage } from '@simon_he/fetch-npm'
import { latestVersion } from '@simon_he/latest-version'
import { createFakeProgress, getConfiguration, getLocale, getRootPath, message } from '@vscode-use/utils'
import { componentsReducer, propsReducer } from '../ui/utils'
import { logger } from '../ui/ui-find'
import { fetchFromCjsForCommonIntellisense } from '@simon_he/fetch-npm-cjs'
import { getPrefix } from '../ui/ui-utils'
import { fetchFromTypes } from '../type-extract'
import { normalizeAdapterManifestExports } from './adapter-manifest'
import { createAdapterVmContext, runAdapterExports } from './adapter-vm'

const prefix = '@common-intellisense/'

export const cacheFetch = new Map<string, string>()
const cacheSchemaVersion = 1
const maxCacheSize = 16 * 1024 * 1024
const maxCacheEntrySize = 8 * 1024 * 1024
const maxCacheEntries = 100

function cacheEntrySize(key: string, value: string) {
  return Buffer.byteLength(key) + Buffer.byteLength(value)
}

function getCacheByteSize() {
  let total = 0
  for (const [key, value] of cacheFetch)
    total += cacheEntrySize(key, value)
  return total
}

function pruneFetchCache() {
  let bytes = getCacheByteSize()
  while (cacheFetch.size > maxCacheEntries || bytes > maxCacheSize) {
    const oldest = cacheFetch.entries().next().value as [string, string] | undefined
    if (!oldest)
      break
    cacheFetch.delete(oldest[0])
    bytes -= cacheEntrySize(oldest[0], oldest[1])
  }
}

export function setFetchCacheEntry(key: string, value: string) {
  if (cacheEntrySize(key, value) > maxCacheEntrySize) {
    cacheFetch.delete(key)
    return false
  }
  cacheFetch.delete(key)
  cacheFetch.set(key, value)
  pruneFetchCache()
  return cacheFetch.get(key) === value
}

export function getFetchCacheEntry(key: string) {
  if (!cacheFetch.has(key))
    return
  const value = cacheFetch.get(key)!
  cacheFetch.delete(key)
  cacheFetch.set(key, value)
  return value
}

export function getFetchCacheStats() {
  return { entries: cacheFetch.size, bytes: getCacheByteSize() }
}
export let localCacheUri = path.join(os.tmpdir(), 'common-intellisense', 'mapping.json')
let cacheReadTask: Promise<string> | null = null
let cacheReadEpoch = 0
let cacheWriteTask: Promise<void> = Promise.resolve()
let cacheWriteEpoch = 0

export function configureCacheStorage(storageUri: vscode.Uri | string) {
  const storagePath = typeof storageUri === 'string' ? storageUri : storageUri.fsPath
  localCacheUri = path.join(storagePath, 'mapping.json')
  cacheReadEpoch++
  cacheWriteEpoch++
  cacheReadTask = null
}

const commonIntellisenseInFlight = new Map<string, Promise<any>>()
const officialAdapterScriptInFlight = new Map<string, Promise<string>>()
const remoteHttpTasks = new Map<string, Promise<Record<string, any>>>()
const remoteNpmTasks = new Map<string, Promise<Record<string, any>>>()
const localTasks = new Map<string, Promise<Record<string, any>>>()
const perSourceTasks = new Map<string, Promise<CustomSourceResult>>()
let sourceEpoch = 0
const retry = 3
const timeout = 600000 // 如果 10 分钟拿不到就认为是 proxy 问题
const remoteUriCacheTTL = 5 * 60 * 1000
const latestVersionCacheTTL = 10 * 60 * 1000
const latestVersionCache = new Map<string, { value: string, at: number }>()
const latestVersionInFlight = new Map<string, Promise<string>>()
const remoteExecTimeout = 1200
const maxRemoteScriptSize = 8 * 1024 * 1024
const maxAdapterResultSize = 8 * 1024 * 1024
const maxTotalAdapterResultSize = 16 * 1024 * 1024
// Bound the host-side outer JSON parse before allocating its object graph.
const maxAdapterEnvelopeSize = maxTotalAdapterResultSize + 1024 * 1024
const maxAdapterDepth = 30
const maxAdapterArrayLength = 20_000
const maxAdapterStringLength = 1_000_000
const maxAdapterObjectKeys = 10_000
const maxAdapterExports = 500
const blockedExportKeys = new Set(['__proto__', 'prototype', 'constructor'])
const remoteUriFetchedAt = new Map<string, number>()
const remoteUriRetry = new Map<string, { failureCount: number, nextRetryAt: number }>()
const remoteRetryDelays = [30_000, 2 * 60_000, 5 * 60_000]
const isZh = getLocale()?.includes('zh')

function mergeComponentsWithTypeFallback(remote: any[], fallback: any[]) {
  if (!Array.isArray(remote) || !remote.length || !Array.isArray(fallback) || !fallback.length)
    return remote
  const fallbackMap = new Map<string, any>()
  for (const item of fallback) {
    if (item?.name)
      fallbackMap.set(item.name, item)
  }
  return remote.map((item) => {
    if (!item?.name)
      return item
    const fb = fallbackMap.get(item.name)
    if (!fb?.props)
      return item
    const mergedProps: Record<string, any> = { ...(item.props || {}) }
    for (const [key, value] of Object.entries(fb.props)) {
      const current = mergedProps[key]
      const currentType = typeof current?.type === 'string' ? current.type.trim() : ''
      const isEmpty = !current || !currentType || currentType === '{}' || currentType === 'object'
      if (isEmpty)
        mergedProps[key] = value
    }
    return { ...item, props: mergedProps }
  })
}

function getSourceTaskKey(kind: string, configuration: unknown, workspaceRoot?: string) {
  return JSON.stringify({
    kind,
    root: workspaceRoot || getRootPath() || '',
    configuration,
    trustedHosts: getConfiguration('common-intellisense.trustedHosts') || [],
    allowLegacyAdapters: getConfiguration('common-intellisense.allowLegacyAdapters') === true,
    workspaceTrusted: vscode.workspace?.isTrusted !== false,
  })
}

function isLegacyAdapterEnabled() {
  return vscode.workspace?.isTrusted !== false
    && getConfiguration('common-intellisense.allowLegacyAdapters') === true
}

function isPrivateIpv4(host: string) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

export function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function isPrivateNetworkHost(hostname: string) {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host.endsWith('.localhost'))
    return true
  const ipVersion = isIP(host)
  if (ipVersion === 4)
    return isPrivateIpv4(host)
  if (ipVersion === 6) {
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice('::ffff:'.length)
      if (isIP(mapped) === 4)
        return isPrivateIpv4(mapped)
      const groups = mapped.split(':')
      if (groups.length === 2) {
        const high = Number.parseInt(groups[0], 16)
        const low = Number.parseInt(groups[1], 16)
        if (Number.isFinite(high) && Number.isFinite(low))
          return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
      }
    }
    return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host) || host.startsWith('ff')
  }
  return false
}

export function isTrustedRedirectUri(uri: string) {
  try {
    const target = new URL(uri)
    return target.protocol === 'https:' && !isPrivateNetworkHost(target.hostname)
  }
  catch {
    return false
  }
}

type ResolveHost = (hostname: string) => Promise<Array<{ address: string, family: number }>>

function isExplicitlyTrustedHost(hostname: string) {
  const trustedHosts = getConfiguration('common-intellisense.trustedHosts') as string[] | undefined
  const normalized = normalizeHostname(hostname)
  return Array.isArray(trustedHosts) && trustedHosts.some(host => normalizeHostname(host) === normalized)
}

function isTrustedRemoteUri(uri: string) {
  try {
    const target = new URL(uri)
    if (target.protocol === 'https:')
      return true
    if (target.protocol !== 'http:')
      return false

    const hostname = normalizeHostname(target.hostname)
    if (['localhost', '127.0.0.1', '::1'].includes(hostname))
      return true

    return isExplicitlyTrustedHost(hostname)
  }
  catch {
    return false
  }
}

function validateAdapterData(value: unknown, source: string, depth = 0): void {
  if (depth > maxAdapterDepth)
    throw new Error(`Adapter result is too deeply nested: ${source}`)
  if (typeof value === 'string' && value.length > maxAdapterStringLength)
    throw new Error(`Adapter string is too large: ${source}`)
  if (Array.isArray(value)) {
    if (value.length > maxAdapterArrayLength)
      throw new Error(`Adapter array is too large: ${source}`)
    value.forEach(item => validateAdapterData(item, source, depth + 1))
  }
  else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length > maxAdapterObjectKeys)
      throw new Error(`Adapter object has too many keys: ${source}`)
    for (const [key, child] of entries) {
      if (blockedExportKeys.has(key))
        throw new Error(`Unsafe adapter key: ${key} (${source})`)
      validateAdapterData(child, source, depth + 1)
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validateLegacyAdapterLimits(keys: string[], resultSizes: number[], source: string, limits = {
  maxExports: maxAdapterExports,
  maxSingleResultSize: maxAdapterResultSize,
  maxTotalResultSize: maxTotalAdapterResultSize,
}) {
  if (keys.length > limits.maxExports)
    throw new Error(`Adapter has too many exports: ${source}`)
  let totalResultSize = 0
  for (let index = 0; index < resultSizes.length; index++) {
    const size = resultSizes[index]
    if (size > limits.maxSingleResultSize)
      throw new Error(`Adapter result is invalid or too large: ${source}#${keys[index] || index}`)
    totalResultSize += size
    if (totalResultSize > limits.maxTotalResultSize)
      throw new Error(`Adapter results are too large in total: ${source}`)
  }
  return totalResultSize
}

function evaluateAdapter(scriptContent: string, source: string, localeZh: boolean, allowLegacyCode: boolean) {
  if (typeof scriptContent !== 'string' || !scriptContent.trim())
    throw new Error(`Adapter is empty: ${source}`)
  if (scriptContent.length > maxRemoteScriptSize)
    throw new Error(`Adapter is too large: ${source}`)

  // Prefer the data-only JSON protocol. Legacy CommonJS remains supported for compatibility.
  try {
    const manifest = JSON.parse(scriptContent)
    if (!isPlainObject(manifest) || manifest.schemaVersion !== 1 || !isPlainObject(manifest.exports))
      throw new Error(`Unsupported adapter manifest schema: ${source}`)
    const exportsData = manifest.exports as Record<string, unknown>
    if (Object.keys(exportsData).length > maxAdapterExports)
      throw new Error(`Adapter has too many exports: ${source}`)
    validateAdapterData(exportsData, source)
    return normalizeAdapterManifestExports(exportsData, source)
  }
  catch (error) {
    if (!(error instanceof SyntaxError))
      throw error
  }

  if (!allowLegacyCode)
    throw new Error(`Executable adapter blocked; enable common-intellisense.allowLegacyAdapters to trust this source: ${source}`)

  // Legacy executable adapter. node:vm limits responsiveness but is not a security sandbox.
  const sandbox: Record<string, any> = {
    module: { exports: {} },
    exports: {},
    require: undefined,
    process: undefined,
    global: undefined,
    Function: undefined,
    eval: undefined,
    __localeZh: localeZh,
    __result: undefined,
  }
  sandbox.exports = sandbox.module.exports
  const context = createAdapterVmContext(sandbox)
  new vm.Script(scriptContent, { filename: source }).runInContext(context, { timeout: remoteExecTimeout })
  const serializedJson = runAdapterExports(context, remoteExecTimeout)
  if (typeof serializedJson !== 'string' || Buffer.byteLength(serializedJson) > maxAdapterEnvelopeSize)
    throw new Error(`Adapter result is invalid or too large: ${source}`)
  const serialized = JSON.parse(serializedJson) as unknown
  if (!Array.isArray(serialized))
    throw new Error(`Adapter result is invalid or too large: ${source}`)

  const keys: string[] = []
  const resultSizes: number[] = []
  const entries: Array<[string, string]> = []
  for (const entry of serialized) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string')
      throw new Error(`Adapter result is invalid or too large: ${source}`)
    keys.push(entry[0])
    resultSizes.push(Buffer.byteLength(entry[1]))
    entries.push([entry[0], entry[1]])
  }
  // Validate every byte budget before parsing any individual export.
  validateLegacyAdapterLimits(keys, resultSizes, source)

  const result: Record<string, unknown> = {}
  for (const [key, json] of entries) {
    const data = JSON.parse(json)
    validateAdapterData(data, `${source}#${key}`)
    result[key] = data
  }
  return result
}

function evaluateAdapterForEpoch(scriptContent: string, source: string, localeZh: boolean, allowLegacyCode: boolean, expectedEpoch: number) {
  if (sourceEpoch !== expectedEpoch)
    throw new Error(`Adapter source invalidated before evaluation: ${source}`)
  return evaluateAdapter(scriptContent, source, localeZh, allowLegacyCode)
}

function appendReducedExports(target: Record<string, any>, exportsData: Record<string, unknown>, source: string) {
  for (const [key, data] of Object.entries(exportsData)) {
    if (blockedExportKeys.has(key))
      continue
    try {
      target[key] = key.endsWith('Components')
        ? () => componentsReducer(data as any)
        : (runtimeOptions?: { resolveFrom?: string, installedVersion?: string, adapterMajor?: string }) => propsReducer(
            runtimeOptions && data && typeof data === 'object' && !Array.isArray(data)
              ? { ...(data as any), ...runtimeOptions }
              : data as any,
          )
    }
    catch (error) {
      logger.error(`Failed to reduce adapter export ${source}#${key}: ${String(error)}`)
    }
  }
}

async function readLocalCache() {
  const epoch = cacheReadEpoch
  const cachePath = localCacheUri
  try {
    const stat = await fsp.stat(cachePath)
    if (stat.size > maxCacheSize)
      throw new Error(`Cache is too large: ${stat.size}`)
    const text = await fsp.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(text)
    const entries = Array.isArray(parsed) ? parsed : parsed?.schemaVersion === cacheSchemaVersion ? parsed.entries : null
    if (!Array.isArray(entries))
      throw new Error('Unsupported cache schema')
    const pendingEntries = new Map<string, string>()
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
        pendingEntries.set(entry[0], entry[1])
    }
    if (epoch === cacheReadEpoch && cachePath === localCacheUri) {
      for (const [key, value] of pendingEntries)
        setFetchCacheEntry(key, value)
    }
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT')
      logger.error(`Failed to read cache ${cachePath}: ${String(error)}`)
  }
  return 'done reading'
}

export const getLocalCache: PromiseLike<string> = {
  then(onfulfilled, onrejected) {
    cacheReadTask ||= readLocalCache()
    return cacheReadTask.then(onfulfilled, onrejected)
  },
}

export function awaitCacheWrites() {
  return cacheWriteTask
}

export function writeLocalCache() {
  const epoch = cacheWriteEpoch
  cacheWriteTask = cacheWriteTask.then(async () => {
    if (epoch !== cacheWriteEpoch)
      return
    pruneFetchCache()
    let payload = JSON.stringify({ schemaVersion: cacheSchemaVersion, entries: Array.from(cacheFetch.entries()) })
    while (Buffer.byteLength(payload) > maxCacheSize && cacheFetch.size) {
      cacheFetch.delete(cacheFetch.keys().next().value!)
      payload = JSON.stringify({ schemaVersion: cacheSchemaVersion, entries: Array.from(cacheFetch.entries()) })
    }
    await fsp.mkdir(path.dirname(localCacheUri), { recursive: true })
    const temporary = `${localCacheUri}.${process.pid}.${Date.now()}.tmp`
    try {
      await fsp.writeFile(temporary, payload, 'utf8')
      if (epoch !== cacheWriteEpoch)
        return
      await fsp.rename(temporary, localCacheUri)
    }
    finally {
      await fsp.rm(temporary, { force: true }).catch(() => {})
    }
  }).catch(error => logger.error(`Failed to write cache ${localCacheUri}: ${String(error)}`))
  return cacheWriteTask
}

async function getLatestVersion(name: string) {
  const cached = latestVersionCache.get(name)
  if (cached && Date.now() - cached.at < latestVersionCacheTTL)
    return cached.value
  const pending = latestVersionInFlight.get(name)
  if (pending)
    return pending
  const epoch = sourceEpoch
  const task = latestVersion(name, { concurrency: 3 }).then((value) => {
    if (sourceEpoch !== epoch)
      throw new Error(`Version request invalidated: ${name}`)
    latestVersionCache.set(name, { value, at: Date.now() })
    return value
  }).finally(() => {
    if (latestVersionInFlight.get(name) === task)
      latestVersionInFlight.delete(name)
  })
  latestVersionInFlight.set(name, task)
  return task
}

function getOfficialAdapterScript(scriptKey: string, name: string, version: string, epoch: number) {
  const cached = getFetchCacheEntry(scriptKey)
  if (cached !== undefined) {
    logger.info(isZh ? `已缓存的 ${scriptKey}` : `cachedKey: ${scriptKey}`)
    return Promise.resolve(cached)
  }
  const pending = officialAdapterScriptInFlight.get(scriptKey)
  if (pending)
    return pending
  logger.info(isZh ? `准备拉取的资源: ${scriptKey}` : `ready fetchingKey: ${scriptKey}`)
  const task = Promise.any([
    fetchAndExtractPackage({ name, dist: 'index.cjs', retry, logger }),
    fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>,
  ]).then((scriptContent) => {
    if (sourceEpoch !== epoch)
      throw new Error(`Adapter source invalidated before caching: ${scriptKey}`)
    if (scriptContent)
      setFetchCacheEntry(scriptKey, scriptContent)
    return scriptContent
  }).finally(() => {
    if (officialAdapterScriptInFlight.get(scriptKey) === task)
      officialAdapterScriptInFlight.delete(scriptKey)
  })
  officialAdapterScriptInFlight.set(scriptKey, task)
  return task
}

// todo: add result type replace any
export async function fetchFromCommonIntellisense(tag: string, options?: { pkgName?: string, uiName?: string, resolveFrom?: string, installedVersion?: string, adapterMajor?: string }) {
  const uiName = options?.uiName || tag.replace(/-(\w)/g, (_, v) => v.toUpperCase())
  const name = prefix + tag
  let version = ''
  logger.info(isZh ? `正在查找 ${name} 的最新版本...` : `Looking for the latest version of ${name}...`)
  try {
    version = await getLatestVersion(name)
  }
  catch (error: any) {
    if (error.message.includes('404 Not Found')) {
      // 说明这个版本还未支持, 可以通过 issue 提出
      logger.error(isZh ? `当前版本并未支持` : `The current version is not supported`)
      const fallback = await fetchFromTypes({ pkgName: options?.pkgName || '', uiName, resolveFrom: options?.resolveFrom })
      if (fallback) {
        logger.info(isZh ? `已从类型兜底: ${options?.pkgName || uiName}` : `Type fallback loaded: ${options?.pkgName || uiName}`)
        return fallback
      }
    }
    else {
      logger.error(`获取最新版本错误: ${String(error)}`)
      const fallback = await fetchFromTypes({ pkgName: options?.pkgName || '', uiName, resolveFrom: options?.resolveFrom })
      if (fallback) {
        logger.info(isZh ? `已从类型兜底: ${options?.pkgName || uiName}` : `Type fallback loaded: ${options?.pkgName || uiName}`)
        return fallback
      }
    }
    return
  }
  logger.info(isZh ? `找到 ${name} 的最新版本: ${version}` : `Found the latest version of ${name}: ${version}`)
  const scriptKey = `${name}@${version}`
  const key = JSON.stringify({
    scriptKey,
    pkgName: options?.pkgName || '',
    uiName,
    resolveFrom: options?.resolveFrom || '',
    installedVersion: options?.installedVersion || '',
    adapterMajor: options?.adapterMajor || '',
  })
  const inFlightTask = commonIntellisenseInFlight.get(key)
  if (inFlightTask)
    return inFlightTask

  const epoch = sourceEpoch
  const task = (async () => {
    let resolver: () => void = () => { }
    let rejecter: (msg?: string) => void = () => { }
    if (!cacheFetch.has(scriptKey)) {
      createFakeProgress({
        title: isZh ? `正在拉取远程的 ${tag}` : `Pulling remote ${tag}`,
        message: v => isZh ? `已完成 ${v}%` : `Completed ${v}%`,
        callback: (resolve, reject) => {
          resolver = resolve
          rejecter = reject
        },
      })
    }

    try {
      const scriptContent = await getOfficialAdapterScript(scriptKey, name, version, epoch)
      // Official @common-intellisense packages remain a trusted compatibility source.
      // Custom executable adapters are opt-in and should migrate to data-only manifests.
      const exportsData = evaluateAdapterForEpoch(scriptContent, scriptKey, !!isZh, true, epoch)
      const result: any = {}
      let fallbackRaw: any[] | undefined
      if (options?.pkgName && options?.resolveFrom) {
        try {
          const fallback = await fetchFromTypes({ pkgName: options.pkgName, uiName, resolveFrom: options.resolveFrom })
          const rawKey = `${uiName}Raw`
          fallbackRaw = fallback?.[rawKey]?.()
        }
        catch {}
      }
      for (const key in exportsData) {
        if (blockedExportKeys.has(key)) {
          logger.error(isZh ? `已跳过不安全导出 key: ${key} (${name})` : `Skipped unsafe export key: ${key} (${name})`)
          continue
        }
        const data = exportsData[key]
        if (key.endsWith('Components')) {
          const lib = key.slice(0, -'Components'.length)
          const userPrefix = getPrefix?.() as Record<string, string> | undefined
          let components = componentsReducer(data as any)

          if (userPrefix && userPrefix[lib]) {
            const customPrefix = userPrefix[lib]
            components = components.map((item: any) => ({ ...item, prefix: customPrefix }))
          }
          result[key] = () => components
        }
        else {
          result[key] = () => {
            let propsData = data
            if (Array.isArray(fallbackRaw) && fallbackRaw.length)
              propsData = mergeComponentsWithTypeFallback(propsData as any[], fallbackRaw)
            return Array.isArray(propsData)
              ? propsReducer({
                  uiName,
                  lib: options?.pkgName || name,
                  map: propsData,
                  resolveFrom: options?.resolveFrom,
                  installedVersion: options?.installedVersion,
                  adapterMajor: options?.adapterMajor,
                })
              : propsReducer({
                  ...(propsData as any),
                  resolveFrom: options?.resolveFrom,
                  installedVersion: options?.installedVersion,
                  adapterMajor: options?.adapterMajor,
                })
          }
        }
      }
      resolver()
      return sourceEpoch === epoch ? result : undefined
    }
    catch (error) {
      rejecter(String(error))
      logger.error(String(error))
      // 尝试从本地获取
      message.error(isZh ? `从远程拉取 UI 包失败 ☹️，请检查代理` : `Failed to pull UI package from remote ☹️, please check the proxy`)
      const fallback = await fetchFromTypes({ pkgName: options?.pkgName || '', uiName, resolveFrom: options?.resolveFrom })
      if (fallback) {
        logger.info(isZh ? `已从类型兜底: ${options?.pkgName || uiName}` : `Type fallback loaded: ${options?.pkgName || uiName}`)
        return fallback
      }
      // Workspace-local adapters are custom sources and are loaded independently
      // by the package enhancement pipeline. Never treat unrelated local exports
      // as a successful official adapter fallback.
      return undefined
      // todo：增加重试机制
    }
  })()
  commonIntellisenseInFlight.set(key, task)
  try {
    return await task
  }
  finally {
    if (commonIntellisenseInFlight.get(key) === task)
      commonIntellisenseInFlight.delete(key)
  }
}

const maxRemoteRedirects = 5

type RemoteTrustClass
  = | { kind: 'publicHttps', initialProtocol: 'https:' }
    | { kind: 'localhostHttp', hostname: string, initialProtocol: 'http:' }
    | { kind: 'explicitTrustedHost', hostname: string, initialProtocol: 'http:' | 'https:' }

async function getRemoteTrustClass(uri: string): Promise<RemoteTrustClass | undefined> {
  const target = new URL(uri)
  const hostname = normalizeHostname(target.hostname)
  if (target.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(hostname))
    return { kind: 'localhostHttp', hostname, initialProtocol: 'http:' }
  // Public HTTPS keeps the stricter public trust class even when explicitly listed.
  if (isTrustedRedirectUri(uri))
    return { kind: 'publicHttps', initialProtocol: 'https:' }
  if ((target.protocol === 'http:' || target.protocol === 'https:') && isExplicitlyTrustedHost(hostname))
    return { kind: 'explicitTrustedHost', hostname, initialProtocol: target.protocol }
}

function isRedirectAllowed(uri: string, trust: RemoteTrustClass) {
  const target = new URL(uri)
  const hostname = normalizeHostname(target.hostname)
  if (trust.kind === 'publicHttps')
    return isTrustedRedirectUri(uri)
  if (trust.initialProtocol === 'https:' && target.protocol !== 'https:')
    return false
  return hostname === trust.hostname && (target.protocol === 'http:' || target.protocol === 'https:')
}

function normalizeAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
}

export function isLoopbackAddress(address: string) {
  const normalized = normalizeAddress(address)
  if (normalized === '::1')
    return true
  if (isIP(normalized) !== 4)
    return false
  const firstOctet = Number(normalized.split('.')[0])
  return firstOctet === 127
}

async function resolvePinnedAddresses(uri: string, trust: RemoteTrustClass, resolveHost: ResolveHost) {
  const target = new URL(uri)
  const hostname = normalizeHostname(target.hostname)
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolveHost(hostname)
  if (!addresses.length)
    throw new Error(`Remote adapter hostname did not resolve: ${hostname}`)
  if (trust.kind === 'publicHttps' && addresses.some(({ address }) => isPrivateNetworkHost(address)))
    throw new Error(`Remote adapter URL is not a trusted public target: ${uri}`)
  if (trust.kind === 'localhostHttp' && addresses.some(({ address }) => !isLoopbackAddress(address)))
    throw new Error(`Localhost adapter resolved to a non-loopback address: ${uri}`)
  return addresses
}

interface PinnedResponse {
  status: number
  location?: string
  body: string
}

export type PinnedRequester = (uri: string, pinned: { address: string, family: number }, trust: RemoteTrustClass) => Promise<PinnedResponse>
let requesterOverride: PinnedRequester | undefined
let resolverOverride: ResolveHost | undefined

export function setRemoteTransportForTest(requester?: PinnedRequester, resolver?: ResolveHost) {
  requesterOverride = requester
  resolverOverride = resolver
}

function requestPinnedText(uri: string, pinned: { address: string, family: number }, trust: RemoteTrustClass): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(uri)
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(target, {
      method: 'GET',
      servername: target.protocol === 'https:' ? target.hostname : undefined,
      lookup(_hostname, options, callback: any) {
        if (typeof options === 'object' && options.all)
          callback(null, [pinned])
        else
          callback(null, pinned.address, pinned.family)
      },
      headers: { accept: 'text/plain, application/json' },
    }, (response) => {
      const status = response.statusCode || 0
      const location = response.headers.location
      if (status >= 300 && status < 400) {
        response.destroy()
        resolve({ status, location, body: '' })
        return
      }
      const contentLength = Number(response.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength > maxRemoteScriptSize) {
        response.destroy()
        reject(new Error(`Remote adapter is too large: ${uri}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > maxRemoteScriptSize) {
          response.destroy(new Error(`Remote adapter is too large: ${uri}`))
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => resolve({ status, location, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.setTimeout(timeout, () => request.destroy(new Error(`Remote adapter request timed out: ${uri}`)))
    request.on('socket', (socket) => {
      socket.once('connect', () => {
        const remoteAddress = normalizeAddress(socket.remoteAddress || '')
        if (remoteAddress !== normalizeAddress(pinned.address)
          || (trust.kind === 'publicHttps' && isPrivateNetworkHost(remoteAddress))
          || (trust.kind === 'localhostHttp' && !isLoopbackAddress(remoteAddress))) {
          request.destroy(new Error(`Remote adapter connected to an untrusted address: ${socket.remoteAddress || 'unknown'}`))
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

export async function fetchRemoteText(
  uri: string,
  resolveHost: ResolveHost = resolverOverride || (hostname => dns.lookup(hostname, { all: true, verbatim: true })),
  requestText: PinnedRequester = requesterOverride || requestPinnedText,
) {
  const trust = await getRemoteTrustClass(uri)
  if (!trust)
    throw new Error(`Remote adapter URL is not a trusted public target: ${uri}`)
  let current = uri
  for (let redirects = 0; redirects <= maxRemoteRedirects; redirects++) {
    const pinnedAddresses = await resolvePinnedAddresses(current, trust, resolveHost)
    let response: PinnedResponse | undefined
    let lastConnectionError: unknown
    for (const pinned of pinnedAddresses) {
      try {
        response = await requestText(current, pinned, trust)
        break
      }
      catch (error) {
        lastConnectionError = error
      }
    }
    if (!response)
      throw lastConnectionError || new Error(`Remote adapter request failed: ${current}`)
    const { status, location, body } = response
    if (status >= 300 && status < 400) {
      if (!location)
        throw new Error(`Remote adapter redirect is missing Location: ${current}`)
      if (redirects === maxRemoteRedirects)
        throw new Error(`Remote adapter exceeded ${maxRemoteRedirects} redirects: ${uri}`)
      const next = new URL(location, current).toString()
      if (!isRedirectAllowed(next, trust))
        throw new Error(`Remote adapter redirected to an untrusted URL: ${next}`)
      current = next
      continue
    }
    if (status >= 400)
      throw new Error(`Remote adapter request failed (${status}): ${current}`)
    return body
  }
  throw new Error(`Remote adapter exceeded ${maxRemoteRedirects} redirects: ${uri}`)
}

export interface CustomSourceResult {
  id: string
  status: 'success' | 'failed'
  value?: Record<string, any>
  error?: unknown
}

function getOrCreateSourceTask(key: string, id: string, load: () => Promise<Record<string, any> | undefined>): Promise<CustomSourceResult> {
  const existing = perSourceTasks.get(key)
  if (existing)
    return existing
  const task = Promise.resolve()
    .then(load)
    .then(value => ({ id, status: 'success' as const, value: value || {} }))
    .catch(error => ({ id, status: 'failed' as const, error }))
    .finally(() => {
      if (perSourceTasks.get(key) === task)
        perSourceTasks.delete(key)
    })
  perSourceTasks.set(key, task)
  return task
}

async function settleCustomSources(items: Array<{ id: string, taskKey: string, load: () => Promise<Record<string, any> | undefined> }>): Promise<CustomSourceResult[]> {
  return Promise.all(items.map(({ id, taskKey, load }) => getOrCreateSourceTask(taskKey, id, load)))
}

export function fetchRemoteUrlSourceResults(): Promise<CustomSourceResult[]> {
  const uris = (getConfiguration('common-intellisense.remoteUris') as string[] | undefined) || []
  const epoch = sourceEpoch
  const trustIdentity = JSON.stringify({ trustedHosts: getConfiguration('common-intellisense.trustedHosts') || [], legacy: isLegacyAdapterEnabled() })
  return settleCustomSources(uris.map(uri => ({
    id: `http:${uri}`,
    taskKey: `${epoch}\0http:${uri}\0${trustIdentity}`,
    load: () => fetchFromRemoteUrlsInternal([uri], epoch),
  })))
}

export function fetchFromRemoteUrls() {
  const uris = (getConfiguration('common-intellisense.remoteUris') as string[] | undefined) || []
  const key = getSourceTaskKey('http', uris)
  const existing = remoteHttpTasks.get(key)
  if (existing)
    return existing
  const epoch = sourceEpoch
  const task = fetchFromRemoteUrlsInternal(uris, epoch)
  remoteHttpTasks.set(key, task)
  return task.finally(() => {
    if (remoteHttpTasks.get(key) === task)
      remoteHttpTasks.delete(key)
  })
}

async function fetchFromRemoteUrlsInternal(uris: string[], epoch: number) {
  if (!uris.length)
    return {}

  const now = Date.now()
  const plans = uris.map((uri) => {
    if (!isTrustedRemoteUri(uri)) {
      logger.error(`Skipped untrusted remoteUri: ${uri}`)
      return null
    }
    const cached = getFetchCacheEntry(uri) || ''
    const lastFetchedAt = remoteUriFetchedAt.get(uri) || 0
    const retryState = remoteUriRetry.get(uri)
    const retryDeferred = !!cached && !!retryState && now < retryState.nextRetryAt
    const needsRefresh = !cached || (!retryDeferred && now - lastFetchedAt >= remoteUriCacheTTL)
    return { uri, cached, needsRefresh }
  }).filter(Boolean) as Array<{ uri: string, cached: string, needsRefresh: boolean }>
  if (!plans.length)
    return {}

  let resolver: () => void = () => { }
  let rejecter: (msg?: string) => void = () => { }
  createFakeProgress({
    title: isZh ? `正在拉取远程文件` : 'Pulling remote files',
    message: v => isZh ? `已完成 ${v}%` : `Completed ${v}%`,
    callback(resolve, reject) {
      resolver = resolve
      rejecter = reject
    },
  })
  logger.info(isZh ? '从 remoteUris 中拉取数据...' : 'Fetching data from remoteUris...')
  try {
    const loaded = await Promise.all(plans.map(async ({ uri, cached, needsRefresh }) => {
      const evaluate = (scriptContent: string) => {
        const reduced: Record<string, any> = {}
        appendReducedExports(reduced, evaluateAdapterForEpoch(scriptContent, uri, getLocale()!.includes('zh'), isLegacyAdapterEnabled(), epoch), uri)
        return reduced
      }
      if (!needsRefresh && cached)
        return evaluate(cached)

      logger.info(isZh ? `正在加载 ${uri}` : `Loading ${uri}`)
      try {
        const fetched = await fetchRemoteText(uri)
        if (typeof fetched !== 'string' || fetched.length > maxRemoteScriptSize)
          throw new Error(`Remote adapter is invalid or too large: ${uri}`)
        if (sourceEpoch !== epoch)
          throw new Error(`Remote adapter configuration changed while loading: ${uri}`)
        // Validate and reduce before replacing the last-known-good cache entry.
        const reduced = evaluate(fetched)
        setFetchCacheEntry(uri, fetched)
        remoteUriFetchedAt.set(uri, Date.now())
        remoteUriRetry.delete(uri)
        return reduced
      }
      catch (error) {
        if (!cached)
          throw error
        const failureCount = (remoteUriRetry.get(uri)?.failureCount || 0) + 1
        const delay = remoteRetryDelays[Math.min(failureCount - 1, remoteRetryDelays.length - 1)]
        remoteUriRetry.set(uri, { failureCount, nextRetryAt: Date.now() + delay })
        logger.error(isZh ? `刷新失败，使用缓存: ${uri}` : `Refresh failed, using cached module: ${uri}`)
        // A malformed cached payload is a real failure, not a successful empty source.
        return evaluate(cached)
      }
    }))
    const result: Record<string, any> = {}
    for (const exportsData of loaded)
      Object.assign(result, exportsData)
    resolver()
    return sourceEpoch === epoch ? result : Promise.reject(new Error('Remote adapter configuration changed'))
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
    if (sourceEpoch !== epoch)
      return {}
    throw error
  }
}

export function fetchRemoteNpmSourceResults(): Promise<CustomSourceResult[]> {
  const uris = (getConfiguration('common-intellisense.remoteNpmUris') as ({ name: string, resource?: string } | string)[] | undefined) || []
  const epoch = sourceEpoch
  return settleCustomSources(uris.map((item) => {
    const name = typeof item === 'string' ? item : item.name
    const resource = typeof item === 'string' ? 'index.cjs' : item.resource || 'index.cjs'
    const id = `npm:${name}::${resource}`
    return {
      id,
      taskKey: `${epoch}\0${id}\0legacy:${isLegacyAdapterEnabled()}`,
      load: () => fetchFromRemoteNpmUrlsInternal([item], epoch),
    }
  }))
}

export function fetchFromRemoteNpmUrls() {
  const uris = (getConfiguration('common-intellisense.remoteNpmUris') as ({ name: string, resource?: string } | string)[] | undefined) || []
  const key = getSourceTaskKey('npm', uris)
  const existing = remoteNpmTasks.get(key)
  if (existing)
    return existing
  const epoch = sourceEpoch
  const task = fetchFromRemoteNpmUrlsInternal(uris, epoch)
  remoteNpmTasks.set(key, task)
  return task.finally(() => {
    if (remoteNpmTasks.get(key) === task)
      remoteNpmTasks.delete(key)
  })
}

async function fetchFromRemoteNpmUrlsInternal(uris: ({ name: string, resource?: string } | string)[], epoch: number) {
  if (!uris.length)
    return {}

  const result: any = {}

  const fixedUris = (await Promise.all(uris.map(async (item) => {
    let name = ''
    let resource = 'index.cjs'
    if (typeof item === 'string') {
      name = item
    }
    else {
      name = item.name
      resource = item.resource || resource
    }
    logger.info(isZh ? `正在查找 ${name} 的最新版本...` : `Looking for the latest version of ${name}...`)
    const version = await getLatestVersion(name)
    if (!version)
      throw new Error(`No supported remote npm adapter version: ${name}`)
    return [name, version, resource]
  }))) as [string, string, string][]

  let resolver: () => void = () => { }
  let rejecter: (msg?: string) => void = () => { }
  createFakeProgress({
    title: isZh ? `正在拉取远程 NPM 文件` : 'Pulling remote NPM files',
    message: v => isZh ? `已完成 ${v}%` : `Completed ${v}%`,
    callback(resolve, reject) {
      resolver = resolve
      rejecter = reject
    },
  })
  logger.info(isZh ? '从 remoteNpmUris 中拉取数据...' : 'Fetching data from remoteNpmUris...')

  try {
    const loaded = await Promise.all(fixedUris.map(async ([name, version, resource]) => {
      const key = `${name}@${version}::${resource}`
      const cached = getFetchCacheEntry(key)
      const scriptContent = cached !== undefined
        ? cached
        : await Promise.any([
            fetchAndExtractPackage({ name, dist: resource, logger }),
            resource === 'index.cjs'
              ? fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>
              : Promise.reject(new Error(`No legacy fallback for ${name}/${resource}`)),
          ])
      const reduced: Record<string, any> = {}
      appendReducedExports(reduced, evaluateAdapterForEpoch(scriptContent || '', key, getLocale()!.includes('zh'), isLegacyAdapterEnabled(), epoch), key)
      if (cached === undefined && scriptContent && sourceEpoch === epoch)
        setFetchCacheEntry(key, scriptContent)
      return reduced
    }))
    for (const exportsData of loaded)
      Object.assign(result, exportsData)
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
    throw error
  }

  if (sourceEpoch !== epoch)
    throw new Error('Remote npm adapter configuration changed')
  return result
}

const localUrisMap = new Map<string, any>()

export function resolveLocalAdapterPath(workspaceRoot: string, configuredUri: string) {
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(root, configuredUri)
  const relative = path.relative(root, target)
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : target
}

export function fetchLocalSourceResults(workspaceRoot?: string): Promise<CustomSourceResult[]> {
  const uris = (getConfiguration('common-intellisense.localUris') as string[] | undefined) || []
  const epoch = sourceEpoch
  const root = workspaceRoot || getRootPath() || ''
  return settleCustomSources(uris.map((configuredUri) => {
    const id = `local:${resolveLocalAdapterPath(root, configuredUri) || configuredUri}`
    return {
      id,
      taskKey: `${epoch}\0${id}\0root:${root}\0legacy:${isLegacyAdapterEnabled()}`,
      load: () => fetchFromLocalUrisInternal([configuredUri], epoch, workspaceRoot),
    }
  }))
}

export function fetchFromLocalUris(workspaceRoot?: string) {
  const uris = (getConfiguration('common-intellisense.localUris') as string[] | undefined) || []
  const key = getSourceTaskKey('local', uris, workspaceRoot)
  const existing = localTasks.get(key)
  if (existing)
    return existing
  const epoch = sourceEpoch
  const task = fetchFromLocalUrisInternal(uris, epoch, workspaceRoot)
  localTasks.set(key, task)
  return task.finally(() => {
    if (localTasks.get(key) === task)
      localTasks.delete(key)
  })
}

async function fetchFromLocalUrisInternal(uris: string[], epoch: number, workspaceRoot?: string) {
  const result: Record<string, any> = {}
  if (!uris.length)
    return result
  if (vscode.workspace && vscode.workspace.isTrusted === false) {
    logger.error(isZh ? '不受信任的工作区已禁用本地适配器' : 'Local adapters are disabled in untrusted workspaces')
    return result
  }
  const root = workspaceRoot || getRootPath()
  if (!root)
    return result
  const normalizedRoot = path.resolve(root)
  for (const configuredUri of uris) {
    try {
      const uri = resolveLocalAdapterPath(normalizedRoot, configuredUri)
      if (!uri) {
        logger.error(`Skipped local adapter outside workspace: ${configuredUri}`)
        continue
      }
      const realUri = await fsp.realpath(uri)
      const realRoot = await fsp.realpath(normalizedRoot)
      const realRelative = path.relative(realRoot, realUri)
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        logger.error(`Skipped local adapter symlink outside workspace: ${configuredUri}`)
        continue
      }
      const scriptContent = await fsp.readFile(realUri, 'utf8')
      if (scriptContent.length > maxRemoteScriptSize)
        throw new Error(`Local adapter is too large: ${uri}`)
      if (getFetchCacheEntry(uri) === scriptContent && localUrisMap.has(uri)) {
        Object.assign(result, localUrisMap.get(uri))
        continue
      }
      const exportsData = evaluateAdapterForEpoch(scriptContent, uri, getLocale()!.includes('zh'), isLegacyAdapterEnabled(), epoch)
      const reduced: Record<string, any> = {}
      appendReducedExports(reduced, exportsData, uri)
      if (sourceEpoch !== epoch)
        continue
      setFetchCacheEntry(uri, scriptContent)
      localUrisMap.set(uri, reduced)
      Object.assign(result, reduced)
    }
    catch (error) {
      logger.error(`Failed to load local adapter ${configuredUri}: ${String(error)}`)
      throw error
    }
  }
  if (sourceEpoch !== epoch)
    throw new Error('Local adapter configuration changed')
  return result
}

export function clearFetchCaches() {
  sourceEpoch++
  cacheReadEpoch++
  cacheWriteEpoch++
  cacheFetch.clear()
  commonIntellisenseInFlight.clear()
  officialAdapterScriptInFlight.clear()
  latestVersionCache.clear()
  latestVersionInFlight.clear()
  remoteUriFetchedAt.clear()
  remoteUriRetry.clear()
  localUrisMap.clear()
  perSourceTasks.clear()
  remoteHttpTasks.clear()
  remoteNpmTasks.clear()
  localTasks.clear()
  cacheReadTask = null
}
