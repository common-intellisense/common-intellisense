import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import dns from 'node:dns/promises'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import process from 'node:process'
import path from 'node:path'
import { isIP } from 'node:net'
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
import { runLegacyAdapterInWorker } from './legacy-adapter-worker'

const prefix = '@common-intellisense/'

export const cacheFetch = new Map<string, string>()
const warnedLegacyAdapterSources = new Set<string>()
const legacyMigrationUrl = 'https://github.com/common-intellisense/common-intellisense#explain-configuration'

export function displayAdapterSource(source: string) {
  try {
    const target = new URL(source)
    target.username = ''
    target.password = ''
    target.search = ''
    target.hash = ''
    return target.toString()
  }
  catch {
    return source.split(/[?#]/, 1)[0]
  }
}

function sanitizeRemoteError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/g, value => displayAdapterSource(value))
  return new Error(message)
}

export function getRemoteSourceIdentity(uri: string) {
  const digest = createHash('sha256').update(uri).digest('hex')
  return {
    requestUri: uri,
    cacheKey: `remote:${digest}`,
    id: `http:${digest}`,
    displayName: displayAdapterSource(uri),
  }
}

/** Warn once per source and session when a custom executable adapter is blocked. */
export function notifyLegacyAdapterBlocked(source: string, approval?: string) {
  const warningKey = approval || source
  if (warnedLegacyAdapterSources.has(warningKey))
    return
  warnedLegacyAdapterSources.add(warningKey)
  const visibleSource = displayAdapterSource(source)
  const restricted = vscode.workspace?.isTrusted === false
  const reason = restricted ? 'Executable adapters are disabled in Restricted Mode.' : 'Executable adapters require source-scoped approval.'
  const approvalHint = approval ? ` Add this exact entry to common-intellisense.legacyAdapterAllowlist: ${approval}.` : ''
  const warning = `${reason} Blocked ${visibleSource}.${approvalHint} Migrate to a data-only manifest, or use the deprecated global escape hatch only for fully trusted configurations.`
  const showWarningMessage = vscode.window?.showWarningMessage
  if (typeof showWarningMessage !== 'function')
    return
  void Promise.resolve(showWarningMessage(warning, 'Open Settings', 'Migration Guide')).then((action) => {
    if (action === 'Open Settings')
      return vscode.commands?.executeCommand?.('workbench.action.openSettings', 'common-intellisense.legacyAdapterAllowlist')
    if (action === 'Migration Guide' && vscode.env?.openExternal && vscode.Uri?.parse)
      return vscode.env.openExternal(vscode.Uri.parse(legacyMigrationUrl))
  }).catch(error => logger.error(`Failed to show legacy adapter migration warning: ${String(error)}`))
}
const cacheSchemaVersion = 2
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

export function deleteFetchCacheEntry(key: string) {
  return cacheFetch.delete(key)
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
// Third-party npm helpers do not expose cancellation. Preserve each raw task until
// it actually settles so caller deadlines and cache resets cannot multiply it.
const rawLatestVersionTasks = new Map<string, Promise<string>>()
const rawNpmChannelTasks = new Map<string, Promise<string>>()
const remoteHttpTasks = new Map<string, Promise<Record<string, any>>>()
const remoteNpmTasks = new Map<string, Promise<Record<string, any>>>()
const localTasks = new Map<string, Promise<Record<string, any>>>()
const perSourceTasks = new Map<string, Promise<Omit<CustomSourceResult, 'configurationIndex'>>>()
let sourceEpoch = 0
const retry = 3
const remoteRequestTimeout = 5_000
const remoteTotalTimeout = 30_000
const npmVersionDeadline = 15_000
const npmDownloadDeadline = 30_000
const remoteUriCacheTTL = 5 * 60 * 1000
const latestVersionCacheTTL = 10 * 60 * 1000
const latestVersionCache = new Map<string, { value: string, at: number }>()
const remoteExecTimeout = 1200
const maxRemoteScriptSize = 8 * 1024 * 1024
const maxAdapterResultSize = 8 * 1024 * 1024
const maxTotalAdapterResultSize = 16 * 1024 * 1024
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

function getLegacyConfigurationIdentity() {
  return {
    emergency: getConfiguration('common-intellisense.allowLegacyAdapters') === true,
    allowlist: (getConfiguration('common-intellisense.legacyAdapterAllowlist') as string[] | undefined) || [],
  }
}

export function getLegacyAdapterApproval(sourceId: string, content: string) {
  return `${sourceId}#sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isLegacyAdapterApproved(sourceId: string, content: string) {
  if (vscode.workspace?.isTrusted === false)
    return false
  const configuration = getLegacyConfigurationIdentity()
  return configuration.emergency || configuration.allowlist.includes(getLegacyAdapterApproval(sourceId, content))
}

function getSourceTaskKey(kind: string, configuration: unknown, workspaceRoot?: string) {
  return JSON.stringify({
    kind,
    root: workspaceRoot || getRootPath() || '',
    configuration,
    trustedHosts: getConfiguration('common-intellisense.trustedHosts') || [],
    legacy: getLegacyConfigurationIdentity(),
    workspaceTrusted: vscode.workspace?.isTrusted !== false,
  })
}

function parseIpv4(address: string) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    return
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n)
}

function parseIpv6(address: string) {
  if (address.includes('%'))
    return
  let input = address.toLowerCase()
  const dottedIndex = input.lastIndexOf(':')
  if (input.includes('.') && dottedIndex >= 0) {
    const ipv4 = parseIpv4(input.slice(dottedIndex + 1))
    if (ipv4 === undefined)
      return
    input = `${input.slice(0, dottedIndex)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xFFFFn).toString(16)}`
  }
  const halves = input.split('::')
  if (halves.length > 2)
    return
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < (halves.length === 2 ? 1 : 0))
    return
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group)))
    return
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

function isInCidr(value: bigint, base: bigint, prefix: number, bits: number) {
  const shift = BigInt(bits - prefix)
  return (value >> shift) === (base >> shift)
}

const nonGlobalIpv4Cidrs: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const nonGlobalIpv6Cidrs: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]

/** Return true only for globally routable unicast IP addresses. */
export function isGloballyRoutableAddress(address: string) {
  const host = normalizeHostname(address)
  if (isIP(host) === 4) {
    const value = parseIpv4(host)
    return value !== undefined && !nonGlobalIpv4Cidrs.some(([base, prefix]) => isInCidr(value, parseIpv4(base)!, prefix, 32))
  }
  if (isIP(host) === 6) {
    const value = parseIpv6(host)
    if (value === undefined)
      return false
    // Globally routable IPv6 unicast currently lives in 2000::/3. Keeping this
    // allowlist conservative prevents new special-purpose ranges being accepted
    // merely because they are absent from a denylist.
    const globalUnicast = isInCidr(value, parseIpv6('2000::')!, 3, 128)
    return globalUnicast && !nonGlobalIpv6Cidrs.some(([base, prefix]) => isInCidr(value, parseIpv6(base)!, prefix, 128))
  }
  return false
}

export function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function isPrivateNetworkHost(hostname: string) {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host.endsWith('.localhost'))
    return true
  return isIP(host) !== 0 && !isGloballyRoutableAddress(host)
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

async function evaluateAdapter(scriptContent: string, source: string, localeZh: boolean, allowLegacyCode: boolean) {
  if (typeof scriptContent !== 'string')
    throw new Error(`Adapter is empty: ${source}`)
  if (scriptContent.length > maxRemoteScriptSize)
    throw new Error(`Adapter is too large: ${source}`)
  // Normalize one UTF-8 BOM for parsing/evaluation. Source signatures remain
  // based on the original bytes, so adding or removing a BOM still invalidates.
  const normalizedContent = scriptContent.charCodeAt(0) === 0xFEFF ? scriptContent.slice(1) : scriptContent
  if (!normalizedContent.trim())
    throw new Error(`Adapter is empty: ${source}`)

  // Prefer the data-only JSON protocol. Legacy CommonJS remains supported for compatibility.
  try {
    const manifest = JSON.parse(normalizedContent)
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

  if (!allowLegacyCode) {
    throw new Error(`Executable adapter blocked: ${source}`)
  }

  // Execute compatibility code in a terminable Worker. This is not a security
  // sandbox, but the parent-owned wall-clock deadline protects Extension Host
  // responsiveness even if code escapes node:vm into nextTick/timer queues.
  const entries = await runLegacyAdapterInWorker(normalizedContent, source, localeZh, remoteExecTimeout, {
    maxExports: maxAdapterExports,
    maxSingleResultSize: maxAdapterResultSize,
    maxTotalResultSize: maxTotalAdapterResultSize,
  })
  const keys = entries.map(([key]) => key)
  const resultSizes = entries.map(([, json]) => Buffer.byteLength(json))
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

async function evaluateAdapterForEpoch(scriptContent: string, source: string, localeZh: boolean, allowLegacyCode: boolean, expectedEpoch: number) {
  if (sourceEpoch !== expectedEpoch)
    throw new Error(`Adapter source invalidated before evaluation: ${source}`)
  const result = await evaluateAdapter(scriptContent, source, localeZh, allowLegacyCode)
  if (sourceEpoch !== expectedEpoch)
    throw new Error(`Adapter source invalidated during evaluation: ${source}`)
  return result
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

export async function withDeadline<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

function getRawLatestVersionTask(name: string) {
  const pending = rawLatestVersionTasks.get(name)
  if (pending)
    return pending
  const epoch = sourceEpoch
  const task = Promise.resolve(latestVersion(name, { concurrency: 3 })).then((value) => {
    if (sourceEpoch === epoch)
      latestVersionCache.set(name, { value, at: Date.now() })
    return value
  }).finally(() => {
    if (rawLatestVersionTasks.get(name) === task)
      rawLatestVersionTasks.delete(name)
  })
  rawLatestVersionTasks.set(name, task)
  return task
}

async function getLatestVersion(name: string) {
  const cached = latestVersionCache.get(name)
  if (cached && Date.now() - cached.at < latestVersionCacheTTL)
    return cached.value
  return withDeadline(getRawLatestVersionTask(name), npmVersionDeadline, `Resolving ${name}`)
}

function getRawNpmChannelTask(key: string, factory: () => Promise<string>) {
  const pending = rawNpmChannelTasks.get(key)
  if (pending)
    return pending
  const task = Promise.resolve().then(factory).finally(() => {
    if (rawNpmChannelTasks.get(key) === task)
      rawNpmChannelTasks.delete(key)
  })
  rawNpmChannelTasks.set(key, task)
  return task
}

function getRawNpmDownloadTask(key: string, name: string, version: string, resource: string) {
  const extract = getRawNpmChannelTask(`${key}:extract`, () => fetchAndExtractPackage({ name, dist: resource, retry, logger }))
  const legacy = resource === 'index.cjs'
    ? getRawNpmChannelTask(`${key}:cjs`, () => fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>)
    : Promise.reject(new Error(`No legacy fallback for ${name}/${resource}`))
  return Promise.any([extract, legacy])
}

function getOfficialAdapterScript(scriptKey: string, name: string, version: string, epoch: number, forceNetwork = false) {
  if (!forceNetwork) {
    const cached = getFetchCacheEntry(scriptKey)
    if (cached !== undefined) {
      logger.info(isZh ? `已缓存的 ${scriptKey}` : `cachedKey: ${scriptKey}`)
      return Promise.resolve({ content: cached, fromCache: true })
    }
  }
  logger.info(isZh ? `准备拉取的资源: ${scriptKey}` : `ready fetchingKey: ${scriptKey}`)
  return withDeadline(getRawNpmDownloadTask(`official:${scriptKey}`, name, version, 'index.cjs'), npmDownloadDeadline, `Downloading ${name}`).then((content) => {
    if (sourceEpoch !== epoch)
      throw new Error(`Adapter source invalidated before validation: ${scriptKey}`)
    return { content, fromCache: false }
  })
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
      const reduceOfficialAdapter = async (scriptContent: string) => {
        // Official @common-intellisense packages remain a trusted compatibility source.
        // Custom executable adapters are opt-in and should migrate to data-only manifests.
        const exportsData = await evaluateAdapterForEpoch(scriptContent, scriptKey, !!isZh, true, epoch)
        const adapterName = tag.replace(/-(\w)/g, (_, value) => value.toUpperCase())
        const expectedBases = new Set([adapterName, uiName].map(value => value.toLowerCase()))
        const hasExpectedExport = Object.keys(exportsData).some(key => expectedBases.has(key.replace(/Components$|Props$/, '').toLowerCase()))
        if (!hasExpectedExport)
          throw new Error(`Missing expected adapter exports: ${uiName}`)
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
            let propsData = data
            if (Array.isArray(fallbackRaw) && fallbackRaw.length)
              propsData = mergeComponentsWithTypeFallback(propsData as any[], fallbackRaw)
            const reducedProps = Array.isArray(propsData)
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
            result[key] = () => reducedProps
          }
        }
        return result
      }

      let loaded = await getOfficialAdapterScript(scriptKey, name, version, epoch)
      let result: any
      try {
        result = await reduceOfficialAdapter(loaded.content)
      }
      catch (error) {
        if (!loaded.fromCache)
          throw error
        deleteFetchCacheEntry(scriptKey)
        loaded = await getOfficialAdapterScript(scriptKey, name, version, epoch, true)
        result = await reduceOfficialAdapter(loaded.content)
      }
      if (sourceEpoch !== epoch)
        return undefined
      if (!loaded.fromCache)
        setFetchCacheEntry(scriptKey, loaded.content)
      resolver()
      return result
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
    | { kind: 'localhostHttp', hostname: string, origin: string, initialProtocol: 'http:' }
    | { kind: 'explicitTrustedHost', hostname: string, origin: string, initialProtocol: 'http:' | 'https:' }

async function getRemoteTrustClass(uri: string): Promise<RemoteTrustClass | undefined> {
  const target = new URL(uri)
  const hostname = normalizeHostname(target.hostname)
  if (target.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(hostname))
    return { kind: 'localhostHttp', hostname, origin: target.origin, initialProtocol: 'http:' }
  // Public HTTPS keeps the stricter public trust class even when explicitly listed.
  if (isTrustedRedirectUri(uri))
    return { kind: 'publicHttps', initialProtocol: 'https:' }
  if ((target.protocol === 'http:' || target.protocol === 'https:') && isExplicitlyTrustedHost(hostname))
    return { kind: 'explicitTrustedHost', hostname, origin: target.origin, initialProtocol: target.protocol }
}

function isRedirectAllowed(uri: string, trust: RemoteTrustClass) {
  const target = new URL(uri)
  const hostname = normalizeHostname(target.hostname)
  if (trust.kind === 'publicHttps')
    return isTrustedRedirectUri(uri)
  if (trust.initialProtocol === 'https:' && target.protocol !== 'https:')
    return false
  return hostname === trust.hostname && target.origin === trust.origin
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

export type PinnedRequester = (uri: string, pinned: { address: string, family: number }, trust: RemoteTrustClass, signal?: AbortSignal) => Promise<PinnedResponse>
let requesterOverride: PinnedRequester | undefined
let resolverOverride: ResolveHost | undefined

export function setRemoteTransportForTest(requester?: PinnedRequester, resolver?: ResolveHost) {
  requesterOverride = requester
  resolverOverride = resolver
}

function requestPinnedText(uri: string, pinned: { address: string, family: number }, trust: RemoteTrustClass, signal?: AbortSignal): Promise<PinnedResponse> {
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
    const abort = () => request.destroy(new Error(`Remote adapter request deadline exceeded: ${uri}`))
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.setTimeout(remoteRequestTimeout, () => request.destroy(new Error(`Remote adapter request timed out: ${uri}`)))
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
  totalTimeout = remoteTotalTimeout,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Remote adapter request deadline exceeded: ${uri}`))
    }, totalTimeout)
  })
  const load = async () => {
    const trust = await getRemoteTrustClass(uri)
    if (!trust)
      throw new Error(`Remote adapter URL is not a trusted public target: ${uri}`)
    let current = uri
    for (let redirects = 0; redirects <= maxRemoteRedirects; redirects++) {
      if (controller.signal.aborted)
        throw new Error(`Remote adapter request deadline exceeded: ${uri}`)
      const pinnedAddresses = await resolvePinnedAddresses(current, trust, resolveHost)
      let response: PinnedResponse | undefined
      let lastConnectionError: unknown
      for (const pinned of pinnedAddresses) {
        if (controller.signal.aborted)
          throw new Error(`Remote adapter request deadline exceeded: ${uri}`)
        try {
          response = await requestText(current, pinned, trust, controller.signal)
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
  try {
    return await Promise.race([load(), deadline])
  }
  catch (error) {
    throw sanitizeRemoteError(error)
  }
  finally {
    if (timer)
      clearTimeout(timer)
    controller.abort()
  }
}

export interface CustomSourceResult {
  id: string
  status: 'success' | 'failed'
  signature?: string
  value?: Record<string, any>
  error?: unknown
  /** Position in the corresponding local/HTTP/npm configuration array. */
  configurationIndex?: number
}

interface CustomSourceLoadValue {
  value?: Record<string, any>
  signature: string
}

function getOrCreateSourceTask(key: string, id: string, load: () => Promise<CustomSourceLoadValue>): Promise<Omit<CustomSourceResult, 'configurationIndex'>> {
  const existing = perSourceTasks.get(key)
  if (existing)
    return existing
  const task = Promise.resolve()
    .then(load)
    .then(result => ({ id, status: 'success' as const, value: result.value || {}, signature: result.signature }))
    .catch(error => ({ id, status: 'failed' as const, error }))
    .finally(() => {
      if (perSourceTasks.get(key) === task)
        perSourceTasks.delete(key)
    })
  perSourceTasks.set(key, task)
  return task
}

async function settleCustomSources(items: Array<{ id: string, taskKey: string, load: () => Promise<CustomSourceLoadValue> }>): Promise<CustomSourceResult[]> {
  return Promise.all(items.map(async ({ id, taskKey, load }, configurationIndex) => ({
    ...await getOrCreateSourceTask(taskKey, id, load),
    configurationIndex,
  })))
}

async function evaluateCustomAdapterForEpoch(content: string, sourceId: string, displayName: string, epoch: number) {
  const approval = getLegacyAdapterApproval(sourceId, content)
  try {
    return await evaluateAdapterForEpoch(content, displayName, getLocale()!.includes('zh'), isLegacyAdapterApproved(sourceId, content), epoch)
  }
  catch (error) {
    if (String(error).includes('Executable adapter blocked'))
      notifyLegacyAdapterBlocked(displayName, approval)
    throw error
  }
}

async function loadRemoteUrlSource(uri: string, epoch: number): Promise<CustomSourceLoadValue> {
  const identity = getRemoteSourceIdentity(uri)
  const { requestUri, cacheKey, displayName } = identity
  if (!isTrustedRemoteUri(uri))
    throw new Error(`Skipped untrusted remoteUri: ${displayName}`)
  const now = Date.now()
  const cached = getFetchCacheEntry(cacheKey) || ''
  const retryState = remoteUriRetry.get(cacheKey)
  const retryDeferred = !!cached && !!retryState && now < retryState.nextRetryAt
  const needsRefresh = !cached || (!retryDeferred && now - (remoteUriFetchedAt.get(cacheKey) || 0) >= remoteUriCacheTTL)
  const evaluate = async (scriptContent: string) => {
    const reduced: Record<string, any> = {}
    appendReducedExports(reduced, await evaluateCustomAdapterForEpoch(scriptContent, identity.id, displayName, epoch), displayName)
    return reduced
  }
  let scriptContent = cached
  if (needsRefresh) {
    try {
      const fetched = await fetchRemoteText(requestUri)
      if (typeof fetched !== 'string' || fetched.length > maxRemoteScriptSize)
        throw new Error(`Remote adapter is invalid or too large: ${displayName}`)
      if (sourceEpoch !== epoch)
        throw new Error(`Remote adapter configuration changed while loading: ${displayName}`)
      // Evaluate the exact bytes before they become the last-known-good cache.
      const value = await evaluate(fetched)
      setFetchCacheEntry(cacheKey, fetched)
      remoteUriFetchedAt.set(cacheKey, Date.now())
      remoteUriRetry.delete(cacheKey)
      return { value, signature: createHash('sha256').update(fetched).digest('hex') }
    }
    catch (error) {
      if (!cached)
        throw sanitizeRemoteError(error)
      const failureCount = (remoteUriRetry.get(cacheKey)?.failureCount || 0) + 1
      const delay = remoteRetryDelays[Math.min(failureCount - 1, remoteRetryDelays.length - 1)]
      remoteUriRetry.set(cacheKey, { failureCount, nextRetryAt: Date.now() + delay })
      logger.error(isZh ? `刷新失败，使用缓存: ${displayName}` : `Refresh failed, using cached module: ${displayName}`)
      scriptContent = cached
    }
  }
  return { value: await evaluate(scriptContent), signature: createHash('sha256').update(scriptContent).digest('hex') }
}

export function fetchRemoteUrlSourceResults(): Promise<CustomSourceResult[]> {
  const uris = (getConfiguration('common-intellisense.remoteUris') as string[] | undefined) || []
  const epoch = sourceEpoch
  const trustIdentity = JSON.stringify({ trustedHosts: getConfiguration('common-intellisense.trustedHosts') || [], legacy: getLegacyConfigurationIdentity() })
  return settleCustomSources(uris.map((uri) => {
    const identity = getRemoteSourceIdentity(uri)
    return { id: identity.id, taskKey: `${epoch}\0${identity.id}\0${trustIdentity}`, load: () => loadRemoteUrlSource(uri, epoch) }
  }))
}

export function fetchFromRemoteUrls() {
  const uris = (getConfiguration('common-intellisense.remoteUris') as string[] | undefined) || []
  const key = getSourceTaskKey('http', uris.map(uri => getRemoteSourceIdentity(uri).cacheKey))
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
  const trusted = uris.filter((uri) => {
    if (isTrustedRemoteUri(uri))
      return true
    logger.error(`Skipped untrusted remoteUri: ${getRemoteSourceIdentity(uri).displayName}`)
    return false
  })
  try {
    const loaded = await Promise.all(trusted.map(uri => loadRemoteUrlSource(uri, epoch)))
    if (sourceEpoch !== epoch)
      return {}
    return Object.assign({}, ...loaded.map(item => item.value || {}))
  }
  catch (error) {
    if (sourceEpoch !== epoch)
      return {}
    throw error
  }
}

export function normalizeNpmResource(input: string) {
  if (!input || input.length > 256 || input.includes('\0') || input.includes('\\') || path.posix.isAbsolute(input))
    throw new Error('Invalid npm adapter resource')
  const normalized = path.posix.normalize(input)
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..'))
    throw new Error('Invalid npm adapter resource')
  return normalized
}

async function loadRemoteNpmSource(item: { name: string, resource?: string } | string, epoch: number): Promise<CustomSourceLoadValue> {
  const name = typeof item === 'string' ? item : item.name
  const resource = normalizeNpmResource(typeof item === 'string' ? 'index.cjs' : item.resource || 'index.cjs')
  const version = await getLatestVersion(name)
  if (!version)
    throw new Error(`No supported remote npm adapter version: ${name}`)
  const key = `${name}@${version}::${resource}`
  const cached = getFetchCacheEntry(key)
  const scriptContent = cached !== undefined
    ? cached
    : await withDeadline(getRawNpmDownloadTask(`remote:${key}`, name, version, resource), npmDownloadDeadline, `Downloading ${name}/${resource}`)
  const reduced: Record<string, any> = {}
  appendReducedExports(reduced, await evaluateCustomAdapterForEpoch(scriptContent || '', `npm:${name}::${resource}`, key, epoch), key)
  if (sourceEpoch !== epoch)
    throw new Error('Remote npm adapter configuration changed')
  if (cached === undefined && scriptContent)
    setFetchCacheEntry(key, scriptContent)
  const signature = createHash('sha256').update(`${key}\0${scriptContent || ''}`).digest('hex')
  return { value: reduced, signature }
}

export function fetchRemoteNpmSourceResults(): Promise<CustomSourceResult[]> {
  const uris = (getConfiguration('common-intellisense.remoteNpmUris') as ({ name: string, resource?: string } | string)[] | undefined) || []
  const epoch = sourceEpoch
  return settleCustomSources(uris.map((item) => {
    const name = typeof item === 'string' ? item : item.name
    const rawResource = typeof item === 'string' ? 'index.cjs' : item.resource || 'index.cjs'
    const id = `npm:${name}::${rawResource}`
    return {
      id,
      taskKey: `${epoch}\0${id}\0legacy:${JSON.stringify(getLegacyConfigurationIdentity())}`,
      load: () => loadRemoteNpmSource(item, epoch),
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
  const loaded = await Promise.all(uris.map(item => loadRemoteNpmSource(item, epoch)))
  return Object.assign({}, ...loaded.map(item => item.value || {}))
}

export function resolveLocalAdapterPath(workspaceRoot: string, configuredUri: string) {
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(root, configuredUri)
  const relative = path.relative(root, target)
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : target
}

/** Resolve a local adapter using the same trust and workspace boundary for loading and watching. */
export async function resolveLocalAdapterFile(workspaceRoot: string, configuredUri: string, options: { allowMissing?: boolean } = {}) {
  if (vscode.workspace?.isTrusted === false || !configuredUri.trim() || configuredUri.trim() === '.')
    return
  const root = path.resolve(workspaceRoot)
  const target = resolveLocalAdapterPath(root, configuredUri)
  if (!target)
    return
  let realRoot: string
  try {
    realRoot = await fsp.realpath(root)
  }
  catch {
    return
  }
  try {
    const [realTarget, stat] = await Promise.all([fsp.realpath(target), fsp.stat(target)])
    const relative = path.relative(realRoot, realTarget)
    if (!stat.isFile() || relative.startsWith('..') || path.isAbsolute(relative))
      return
    return target
  }
  catch {
    if (!options.allowMissing)
      return
    try {
      const realParent = await fsp.realpath(path.dirname(target))
      const relative = path.relative(realRoot, realParent)
      if (relative.startsWith('..') || path.isAbsolute(relative))
        return
      return target
    }
    catch {}
  }
}

async function loadLocalSource(configuredUri: string, epoch: number, workspaceRoot?: string): Promise<CustomSourceLoadValue> {
  if (vscode.workspace && vscode.workspace.isTrusted === false)
    throw new Error('Local adapters are disabled in untrusted workspaces')
  const root = workspaceRoot || getRootPath()
  if (!root)
    throw new Error('Local adapter workspace root is unavailable')
  const normalizedRoot = path.resolve(root)
  const uri = await resolveLocalAdapterFile(normalizedRoot, configuredUri)
  if (!uri)
    throw new Error(`Skipped unsafe local adapter: ${configuredUri}`)
  const realUri = await fsp.realpath(uri)
  const scriptContent = await fsp.readFile(realUri, 'utf8')
  if (scriptContent.length > maxRemoteScriptSize)
    throw new Error(`Local adapter is too large: ${uri}`)
  const signature = createHash('sha256').update(scriptContent).digest('hex')
  // Always re-check the current source/digest approval before reusing executable
  // output. A configuration change must not inherit code authorized earlier.
  const sourceId = `local:${uri}`
  const exportsData = await evaluateCustomAdapterForEpoch(scriptContent, sourceId, uri, epoch)
  const reduced: Record<string, any> = {}
  appendReducedExports(reduced, exportsData, uri)
  if (sourceEpoch !== epoch)
    throw new Error('Local adapter configuration changed')
  setFetchCacheEntry(uri, scriptContent)
  return { value: reduced, signature }
}

export function fetchLocalSourceResults(workspaceRoot?: string): Promise<CustomSourceResult[]> {
  const uris = (getConfiguration('common-intellisense.localUris') as string[] | undefined) || []
  const epoch = sourceEpoch
  const root = workspaceRoot || getRootPath() || ''
  return settleCustomSources(uris.map((configuredUri) => {
    const id = `local:${resolveLocalAdapterPath(root, configuredUri) || configuredUri}`
    return {
      id,
      taskKey: `${epoch}\0${id}\0root:${root}\0legacy:${JSON.stringify(getLegacyConfigurationIdentity())}`,
      load: () => loadLocalSource(configuredUri, epoch, workspaceRoot),
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
  if (!uris.length)
    return {}
  const loaded = await Promise.all(uris.map(item => loadLocalSource(item, epoch, workspaceRoot)))
  return Object.assign({}, ...loaded.map(item => item.value || {}))
}

export function clearFetchCaches() {
  sourceEpoch++
  cacheReadEpoch++
  cacheWriteEpoch++
  cacheFetch.clear()
  commonIntellisenseInFlight.clear()
  latestVersionCache.clear()
  // Intentionally keep unresolved raw npm tasks: the helpers expose no abort
  // interface, and dropping these entries would allow retries to multiply them.
  remoteUriFetchedAt.clear()
  remoteUriRetry.clear()
  perSourceTasks.clear()
  remoteHttpTasks.clear()
  remoteNpmTasks.clear()
  localTasks.clear()
  cacheReadTask = null
}
