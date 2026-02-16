import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
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

export const cacheFetch = new Map()
export const localCacheUri = path.resolve(__dirname, 'mapping.json')
const commonIntellisenseInFlight = new Map<string, Promise<any>>()
let isRemoteHttpUrisInProgress = false
let isRemoteNpmUrisInProgress = false
let isLocalUrisInProgress = false
const retry = 3
const timeout = 600000 // 如果 10 分钟拿不到就认为是 proxy 问题
const remoteUriCacheTTL = 5 * 60 * 1000
const remoteExecTimeout = 1200
const maxRemoteScriptSize = 8 * 1024 * 1024
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

function evaluateRemoteModule(scriptContent: string, source: string) {
  if (typeof scriptContent !== 'string' || !scriptContent.trim())
    throw new Error(`Remote module is empty: ${source}`)
  if (scriptContent.length > maxRemoteScriptSize)
    throw new Error(`Remote module is too large: ${source}`)

  const module = { exports: {} as Record<string, any> }
  const sandbox: Record<string, any> = {
    module,
    exports: module.exports,
    require: undefined,
    process: undefined,
    global: undefined,
    Function: undefined,
    eval: undefined,
  }
  const context = vm.createContext(sandbox)
  const script = new vm.Script(scriptContent, { filename: source })
  script.runInContext(context, { timeout: remoteExecTimeout })
  return module.exports
}

function appendReducedExports(target: Record<string, any>, moduleExports: Record<string, any>, localeZh: boolean, source: string) {
  for (const key in moduleExports) {
    if (blockedExportKeys.has(key)) {
      logger.error(isZh ? `已跳过不安全导出 key: ${key} (${source})` : `Skipped unsafe export key: ${key} (${source})`)
      continue
    }
    const handler = moduleExports[key]
    if (typeof handler !== 'function') {
      logger.error(isZh ? `已跳过非函数导出 key: ${key} (${source})` : `Skipped non-function export: ${key} (${source})`)
      continue
    }

    if (key.endsWith('Components')) {
      target[key] = () => componentsReducer(handler(localeZh))
    }
    else {
      target[key] = () => propsReducer(handler())
    }
  }
}

export const getLocalCache = new Promise((resolve) => {
  if (existsSync(localCacheUri)) {
    fsp.readFile(localCacheUri, 'utf-8').then((res) => {
      logger.info(isZh ? `正在读取 ${localCacheUri} 中的数据` : `Reading data from ${localCacheUri}`)
      try {
        const oldMap = JSON.parse(res) as [string, string][]
        oldMap.forEach(([key, value]) => {
          if (value)
            cacheFetch.set(key, value)
        })
      }
      catch (error) {
        logger.error(String(error))
      }
      resolve('done reading')
      // 列出已有的 key
      const cacheKey = Array.from(cacheFetch.keys()).join(' | ')
      logger.info(isZh ? `缓存读取完成, 已缓存的 key: ${cacheKey}` : `Cache read complete, cached keys: ${cacheKey}`)
    })
  }
  else {
    resolve('done reading')
  }
})

// todo: add result type replace any
export async function fetchFromCommonIntellisense(tag: string, options?: { pkgName?: string, uiName?: string, resolveFrom?: string }) {
  const uiName = options?.uiName || tag.replace(/-(\w)/g, (_, v) => v.toUpperCase())
  const name = prefix + tag
  let version = ''
  logger.info(isZh ? `正在查找 ${name} 的最新版本...` : `Looking for the latest version of ${name}...`)
  try {
    version = await latestVersion(name, { concurrency: 3 })
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
  const key = `${name}@${version}`
  const inFlightTask = commonIntellisenseInFlight.get(key)
  if (inFlightTask)
    return inFlightTask

  const task = (async () => {
    let resolver: () => void = () => { }
    let rejecter: (msg?: string) => void = () => { }
    if (!cacheFetch.has(key)) {
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
      if (cacheFetch.has(key)) {
        logger.info(isZh ? `已缓存的 ${key}` : `cachedKey: ${key}`)
        scriptContent = cacheFetch.get(key)
      }
      else {
        logger.info(isZh ? `准备拉取的资源: ${key}` : `ready fetchingKey: ${key}`)
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
      if (scriptContent)
        cacheFetch.set(key, scriptContent)
      const moduleExports = evaluateRemoteModule(scriptContent, key)
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
      for (const key in moduleExports) {
        if (blockedExportKeys.has(key)) {
          logger.error(isZh ? `已跳过不安全导出 key: ${key} (${name})` : `Skipped unsafe export key: ${key} (${name})`)
          continue
        }
        const v = moduleExports[key]
        if (typeof v !== 'function') {
          logger.error(isZh ? `已跳过非函数导出 key: ${key} (${name})` : `Skipped non-function export: ${key} (${name})`)
          continue
        }
        if (key.endsWith('Components')) {
          const lib = key.slice(0, -'Components'.length)
          const userPrefix = getPrefix?.() as Record<string, string> | undefined
          let components = componentsReducer(v(isZh))

          if (userPrefix && userPrefix[lib]) {
            const customPrefix = userPrefix[lib]
            components = components.map((item: any) => ({ ...item, prefix: customPrefix }))
          }
          result[key] = () => components
        }
        else {
          result[key] = () => {
            let data = v()
            if (Array.isArray(fallbackRaw) && fallbackRaw.length)
              data = mergeComponentsWithTypeFallback(data, fallbackRaw)
            return propsReducer(data)
          }
        }
      }
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
      return fetchFromLocalUris()
      // todo：增加重试机制
    }
  })()
  commonIntellisenseInFlight.set(key, task)
  try {
    return await task
  }
  finally {
    commonIntellisenseInFlight.delete(key)
  }
}

const tempCache = new Map()
export async function fetchFromRemoteUrls() {
  // 读取 urls
  const uris = getConfiguration('common-intellisense.remoteUris') as string[]
  if (!uris.length)
    return

  const result: any = {}

  if (isRemoteHttpUrisInProgress)
    return

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
  isRemoteHttpUrisInProgress = true
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
    const scriptContents = await Promise.all(plans.map(async ({ uri, cached, needsRefresh }) => {
      if (!needsRefresh && cached)
        return [uri, cached] as const

      logger.info(isZh ? `正在加载 ${uri}` : `Loading ${uri}`)
      try {
        const fetched = await ofetch(uri, { responseType: 'text', retry, timeout })
        if (fetched)
          cacheFetch.set(uri, fetched)
        remoteUriFetchedAt.set(uri, Date.now())
        return [uri, fetched] as const
      }
      catch (error) {
        if (cached) {
          logger.error(isZh ? `刷新失败，使用缓存: ${uri}` : `Refresh failed, using cached module: ${uri}`)
          remoteUriFetchedAt.set(uri, Date.now())
          return [uri, cached] as const
        }
        throw error
      }
    }))
    scriptContents.forEach(([uri, scriptContent]) => {
      const moduleExports = evaluateRemoteModule(scriptContent, uri)
      appendReducedExports(result, moduleExports, getLocale()!.includes('zh'), uri)
    })
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }
  isRemoteHttpUrisInProgress = false

  return result
}

export async function fetchFromRemoteNpmUrls() {
  // 读取 urls
  const uris = getConfiguration('common-intellisense.remoteNpmUris') as ({ name: string, resource?: string } | string)[]
  if (!uris.length)
    return

  const result: any = {}

  if (isRemoteNpmUrisInProgress)
    return

  const fixedUris = (await Promise.all(uris.map(async (item) => {
    let name = ''
    if (typeof item === 'string') {
      name = item
    }
    else {
      name = item.name
    }
    let version = ''
    logger.info(isZh ? `正在查找 ${name} 的最新版本...` : `Looking for the latest version of ${name}...`)
    try {
      version = await latestVersion(name, { concurrency: 3 })
    }
    catch (error: any) {
      if (error.message.includes('404 Not Found')) {
        logger.error(isZh ? `当前版本并未支持` : `The current version is not supported`)
      }
      else {
        logger.error(String(error))
      }
    }
    const key = `remote-npm-uri:${name}`
    const cachedVersion = tempCache.get(key)
    if (cachedVersion === version)
      return ''
    tempCache.set(key, version)
    return [name, version]
  }))).filter(Boolean) as [string, string][]

  if (!fixedUris.length)
    return

  let resolver: () => void = () => { }
  let rejecter: (msg?: string) => void = () => { }
  isRemoteNpmUrisInProgress = true

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
    (await Promise.all(fixedUris.map(async ([name, version]) => {
      const key = `${name}@${version}`
      if (cacheFetch.has(key))
        return [key, cacheFetch.get(key)] as const

      const scriptContent = await Promise.any([
        fetchAndExtractPackage({ name, dist: 'index.cjs', logger }),
        fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>,
      ])

      if (scriptContent)
        cacheFetch.set(key, scriptContent)
      return [key, scriptContent] as const
    }))).forEach(([key, scriptContent]) => {
      const moduleExports = evaluateRemoteModule(scriptContent, key)
      appendReducedExports(result, moduleExports, getLocale()!.includes('zh'), key)
    })
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }
  isRemoteNpmUrisInProgress = false

  return result
}

const localUrisMap = new Map<string, any>()
export async function fetchFromLocalUris() {
  const uris = getConfiguration('common-intellisense.localUris') as string[]
  if (!uris.length)
    return
  logger.info(`localUris: ${uris}`)
  const result: any = {}
  // 查找本地文件 是否存在
  const scriptContents = (await Promise.all(uris.map(async (uri) => {
    // 如果是相对路径，转换为绝对路径，否则直接用
    if (uri.startsWith('./'))
      uri = path.resolve(getRootPath()!, uri)

    if (existsSync(uri)) {
      // 如果缓存中已存在, 比较内容是否改变, 没改变则不再处理, 直接通过
      const scriptContent = await fsp.readFile(uri, 'utf-8')
      if (cacheFetch.has(uri) && cacheFetch.get(uri) === scriptContent && localUrisMap.has(uri)) {
        const temp = localUrisMap.get(uri)!
        Object.assign(result, temp)
        return
      }
      else if (localUrisMap.has(uri)) {
        localUrisMap.delete(uri)
      }
      cacheFetch.set(uri, scriptContent)
      return [uri, scriptContent]
    }
    else {
      logger.error(isZh ? `加载本地文件不存在: [${uri}]` : `Local file does not exist: [${uri}]`)
      return false
    }
  }))).filter(Boolean) as [string, string][]

  if (!scriptContents.length)
    return result

  if (isLocalUrisInProgress)
    return
  let resolver!: () => void
  let rejecter!: (msg?: string) => void
  isLocalUrisInProgress = true
  createFakeProgress({
    title: isZh ? `正在加载本地文件` : 'Loading local files',
    message: v => isZh ? `已完成 ${v}%` : `Completed ${v}%`,
    callback(resolve, reject) {
      resolver = resolve
      rejecter = reject
    },
  })
  try {
    scriptContents.forEach(async ([uri, scriptContent]) => {
      const module: any = {}
      const runModule = new Function('module', scriptContent)
      runModule(module)
      const moduleExports = module.exports
      const temp: any = {}
      const isZh = getLocale()!.includes('zh')
      for (const key in moduleExports) {
        const v = moduleExports[key]
        if (key.endsWith('Components')) {
          temp[key] = () => componentsReducer(v(isZh))
        }
        else {
          temp[key] = () => propsReducer(v())
        }
      }
      localUrisMap.set(uri, temp)
      Object.assign(result, temp)
    })
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }

  isLocalUrisInProgress = false
  return result
}
