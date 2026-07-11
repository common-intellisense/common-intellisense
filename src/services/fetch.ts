import { Buffer } from 'node:buffer'
import dns from 'node:dns/promises'
import fsp from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import path from 'node:path'
import { isIP } from 'node:net'
import vm from 'node:vm'
import * as vscode from 'vscode'
import { fetchAndExtractPackage } from '@simon_he/fetch-npm'
import { latestVersion } from '@simon_he/latest-version'
import { createFakeProgress, getConfiguration, getLocale, getRootPath, message } from '@vscode-use/utils'
import { ofetch } from 'ofetch'
import { componentsReducer, propsReducer } from '../ui/utils'
import { logger } from '../ui/ui-find'
import { fetchFromCjsForCommonIntellisense } from '@simon_he/fetch-npm-cjs'
import { getPrefix } from '../ui/ui-utils'
import { fetchFromTypes } from '../type-extract'

const prefix = '@common-intellisense/'

export const cacheFetch = new Map<string, string>()
const cacheSchemaVersion = 1
const maxCacheSize = 16 * 1024 * 1024
export let localCacheUri = path.join(os.tmpdir(), 'common-intellisense', 'mapping.json')
let cacheReadTask: Promise<string> | null = null
let cacheWriteTask: Promise<void> = Promise.resolve()

export function configureCacheStorage(storageUri: vscode.Uri | string) {
  const storagePath = typeof storageUri === 'string' ? storageUri : storageUri.fsPath
  localCacheUri = path.join(storagePath, 'mapping.json')
  cacheReadTask = null
}

const commonIntellisenseInFlight = new Map<string, Promise<any>>()
const remoteHttpTasks = new Map<string, Promise<Record<string, any> | undefined>>()
const remoteNpmTasks = new Map<string, Promise<Record<string, any> | undefined>>()
const localTasks = new Map<string, Promise<Record<string, any>>>()
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
const maxAdapterDepth = 30
const maxAdapterArrayLength = 20_000
const maxAdapterStringLength = 1_000_000
const maxAdapterObjectKeys = 10_000
const maxAdapterExports = 500
const blockedExportKeys = new Set(['__proto__', 'prototype', 'constructor'])
const remoteUriFetchedAt = new Map<string, number>()
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

function isPrivateNetworkHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
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

async function validateRedirectTarget(uri: string, resolveHost: ResolveHost) {
  if (!isTrustedRedirectUri(uri))
    return false
  const hostname = new URL(uri).hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname))
    return true
  try {
    const addresses = await resolveHost(hostname)
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateNetworkHost(address))
  }
  catch {
    return false
  }
}

function isTrustedRemoteUri(uri: string) {
  try {
    const target = new URL(uri)
    if (target.protocol === 'https:')
      return true
    if (target.protocol !== 'http:')
      return false

    if (['localhost', '127.0.0.1', '::1'].includes(target.hostname))
      return true

    const trustedHosts = getConfiguration('common-intellisense.trustedHosts') as string[] | undefined
    return Array.isArray(trustedHosts) && trustedHosts.includes(target.hostname)
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
    return exportsData
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
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  new vm.Script(scriptContent, { filename: source }).runInContext(context, { timeout: remoteExecTimeout })
  const keys = new vm.Script('Object.keys(module.exports)').runInContext(context, { timeout: remoteExecTimeout }) as string[]
  validateLegacyAdapterLimits(keys, [], source)
  const result: Record<string, unknown> = {}
  let totalResultSize = 0
  for (const key of keys) {
    if (blockedExportKeys.has(key))
      continue
    sandbox.__key = key
    const json = new vm.Script(`(() => {
      const value = module.exports[__key]
      const data = typeof value === 'function' ? value(__key.endsWith('Components') ? __localeZh : undefined) : value
      return JSON.stringify(data)
    })()`).runInContext(context, { timeout: remoteExecTimeout })
    if (typeof json !== 'string')
      throw new Error(`Adapter result is invalid or too large: ${source}#${key}`)
    const resultSize = Buffer.byteLength(json)
    validateLegacyAdapterLimits([key], [resultSize], source, {
      maxExports: maxAdapterExports,
      maxSingleResultSize: maxAdapterResultSize,
      maxTotalResultSize: maxTotalAdapterResultSize - totalResultSize,
    })
    totalResultSize += resultSize
    const data = JSON.parse(json)
    validateAdapterData(data, `${source}#${key}`)
    result[key] = data
  }
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
  try {
    const stat = await fsp.stat(localCacheUri)
    if (stat.size > maxCacheSize)
      throw new Error(`Cache is too large: ${stat.size}`)
    const text = await fsp.readFile(localCacheUri, 'utf8')
    const parsed = JSON.parse(text)
    const entries = Array.isArray(parsed) ? parsed : parsed?.schemaVersion === cacheSchemaVersion ? parsed.entries : null
    if (!Array.isArray(entries))
      throw new Error('Unsupported cache schema')
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
        cacheFetch.set(entry[0], entry[1])
    }
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT')
      logger.error(`Failed to read cache ${localCacheUri}: ${String(error)}`)
  }
  return 'done reading'
}

export const getLocalCache: PromiseLike<string> = {
  then(onfulfilled, onrejected) {
    cacheReadTask ||= readLocalCache()
    return cacheReadTask.then(onfulfilled, onrejected)
  },
}

export function writeLocalCache() {
  cacheWriteTask = cacheWriteTask.then(async () => {
    const payload = JSON.stringify({ schemaVersion: cacheSchemaVersion, entries: Array.from(cacheFetch.entries()) })
    if (Buffer.byteLength(payload) > maxCacheSize)
      throw new Error(`Cache payload exceeds ${maxCacheSize} bytes`)
    await fsp.mkdir(path.dirname(localCacheUri), { recursive: true })
    const temporary = `${localCacheUri}.${process.pid}.${Date.now()}.tmp`
    try {
      await fsp.writeFile(temporary, payload, 'utf8')
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
      let scriptContent = ''
      if (cacheFetch.has(scriptKey)) {
        logger.info(isZh ? `已缓存的 ${scriptKey}` : `cachedKey: ${scriptKey}`)
        scriptContent = cacheFetch.get(scriptKey) || ''
      }
      else {
        logger.info(isZh ? `准备拉取的资源: ${scriptKey}` : `ready fetchingKey: ${scriptKey}`)
        scriptContent = await Promise.any([
          fetchAndExtractPackage({
            name,
            dist: 'index.cjs',
            retry,
            logger,
          }),
          fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>,
        ])
      }
      if (scriptContent && sourceEpoch === epoch)
        cacheFetch.set(scriptKey, scriptContent)
      // Official @common-intellisense packages remain a trusted compatibility source.
      // Custom executable adapters are opt-in and should migrate to data-only manifests.
      const exportsData = evaluateAdapter(scriptContent, scriptKey, !!isZh, true)
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
      const fallbackRoot = options?.resolveFrom
        ? path.extname(options.resolveFrom) ? path.dirname(options.resolveFrom) : options.resolveFrom
        : undefined
      return fetchFromLocalUris(fallbackRoot)
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

export async function fetchRemoteText(uri: string, resolveHost: ResolveHost = hostname => dns.lookup(hostname, { all: true, verbatim: true })) {
  let current = uri
  for (let redirects = 0; redirects <= maxRemoteRedirects; redirects++) {
    let status = 0
    let location: string | null = null
    const body = await ofetch(current, {
      responseType: 'text',
      retry,
      timeout,
      redirect: 'manual',
      ignoreResponseError: true,
      onResponse({ response }) {
        status = response.status
        location = response.headers.get('location')
      },
    })
    if (status >= 300 && status < 400) {
      if (!location)
        throw new Error(`Remote adapter redirect is missing Location: ${current}`)
      if (redirects === maxRemoteRedirects)
        throw new Error(`Remote adapter exceeded ${maxRemoteRedirects} redirects: ${uri}`)
      const next = new URL(location, current).toString()
      if (!await validateRedirectTarget(next, resolveHost))
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
    return

  const result: any = {}

  const now = Date.now()
  const plans = uris.map((uri) => {
    if (!isTrustedRemoteUri(uri)) {
      logger.error(isZh
        ? `已跳过不受信任的 remoteUri: ${uri}（仅允许 https，或 localhost/127.0.0.1 的 http；可通过 trustedHosts 放行）`
        : `Skipped untrusted remoteUri: ${uri} (only https, or localhost/127.0.0.1 http; use trustedHosts to allow)`)
      return null
    }
    const cached = cacheFetch.has(uri) ? cacheFetch.get(uri) : ''
    const lastFetchedAt = remoteUriFetchedAt.get(uri) || 0
    const needsRefresh = !cached || now - lastFetchedAt >= remoteUriCacheTTL
    return { uri, cached, needsRefresh }
  }).filter(Boolean) as Array<{ uri: string, cached: string, needsRefresh: boolean }>

  if (!plans.length)
    return result

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
    const settled = await Promise.allSettled(plans.map(async ({ uri, cached, needsRefresh }) => {
      if (!needsRefresh && cached)
        return [uri, cached] as const
      logger.info(isZh ? `正在加载 ${uri}` : `Loading ${uri}`)
      try {
        const fetched = await fetchRemoteText(uri)
        if (typeof fetched !== 'string' || fetched.length > maxRemoteScriptSize)
          throw new Error(`Remote adapter is invalid or too large: ${uri}`)
        if (sourceEpoch !== epoch)
          throw new Error(`Remote adapter configuration changed while loading: ${uri}`)
        cacheFetch.set(uri, fetched)
        remoteUriFetchedAt.set(uri, Date.now())
        return [uri, fetched] as const
      }
      catch (error) {
        if (cached) {
          logger.error(isZh ? `刷新失败，使用缓存: ${uri}` : `Refresh failed, using cached module: ${uri}`)
          return [uri, cached] as const
        }
        throw error
      }
    }))
    for (const entry of settled) {
      if (entry.status === 'rejected') {
        logger.error(String(entry.reason))
        continue
      }
      const [uri, scriptContent] = entry.value
      try {
        appendReducedExports(result, evaluateAdapter(scriptContent, uri, getLocale()!.includes('zh'), isLegacyAdapterEnabled()), uri)
      }
      catch (error) {
        logger.error(`Failed to evaluate remote adapter ${uri}: ${String(error)}`)
      }
    }
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }
  return sourceEpoch === epoch ? result : {}
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
    return

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
    let version = ''
    logger.info(isZh ? `正在查找 ${name} 的最新版本...` : `Looking for the latest version of ${name}...`)
    try {
      version = await getLatestVersion(name)
    }
    catch (error: any) {
      if (error.message.includes('404 Not Found')) {
        logger.error(isZh ? `当前版本并未支持` : `The current version is not supported`)
      }
      else {
        logger.error(String(error))
      }
    }
    return version ? [name, version, resource] : ''
  }))).filter(Boolean) as [string, string, string][]

  if (!fixedUris.length)
    return

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
    const settled = await Promise.allSettled(fixedUris.map(async ([name, version, resource]) => {
      const key = `${name}@${version}::${resource}`
      if (cacheFetch.has(key))
        return [key, cacheFetch.get(key)] as const

      const scriptContent = await Promise.any([
        fetchAndExtractPackage({ name, dist: resource, logger }),
        resource === 'index.cjs'
          ? fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>
          : Promise.reject(new Error(`No legacy fallback for ${name}/${resource}`)),
      ])

      if (scriptContent && sourceEpoch === epoch)
        cacheFetch.set(key, scriptContent)
      return [key, scriptContent] as const
    }))
    for (const entry of settled) {
      if (entry.status === 'rejected') {
        logger.error(String(entry.reason))
        continue
      }
      const [key, scriptContent] = entry.value
      try {
        const exportsData = evaluateAdapter(scriptContent || '', key, getLocale()!.includes('zh'), isLegacyAdapterEnabled())
        appendReducedExports(result, exportsData, key)
      }
      catch (error) {
        logger.error(`Failed to evaluate npm adapter ${key}: ${String(error)}`)
      }
    }
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }

  return sourceEpoch === epoch ? result : {}
}

const localUrisMap = new Map<string, any>()

export function resolveLocalAdapterPath(workspaceRoot: string, configuredUri: string) {
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(root, configuredUri)
  const relative = path.relative(root, target)
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : target
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
      if (cacheFetch.get(uri) === scriptContent && localUrisMap.has(uri)) {
        Object.assign(result, localUrisMap.get(uri))
        continue
      }
      const exportsData = evaluateAdapter(scriptContent, uri, getLocale()!.includes('zh'), isLegacyAdapterEnabled())
      const reduced: Record<string, any> = {}
      appendReducedExports(reduced, exportsData, uri)
      if (sourceEpoch !== epoch)
        continue
      cacheFetch.set(uri, scriptContent)
      localUrisMap.set(uri, reduced)
      Object.assign(result, reduced)
    }
    catch (error) {
      logger.error(`Failed to load local adapter ${configuredUri}: ${String(error)}`)
    }
  }
  return sourceEpoch === epoch ? result : {}
}

export function clearFetchCaches() {
  sourceEpoch++
  cacheFetch.clear()
  commonIntellisenseInFlight.clear()
  latestVersionCache.clear()
  latestVersionInFlight.clear()
  remoteUriFetchedAt.clear()
  localUrisMap.clear()
  remoteHttpTasks.clear()
  remoteNpmTasks.clear()
  localTasks.clear()
  cacheReadTask = null
}
