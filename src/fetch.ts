import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fetchAndExtractPackage } from '@simon_he/fetch-npm'
import { latestVersion } from '@simon_he/latest-version'
import { createFakeProgress, getConfiguration, getLocale, getRootPath, message } from '@vscode-use/utils'
import { ofetch } from 'ofetch'
import { componentsReducer, propsReducer } from './ui/utils'
import { logger } from './ui-find'
import { fetchFromCjsForCommonIntellisense } from '@simon_he/fetch-npm-cjs'
import { getPrefix } from './ui-utils'

const prefix = '@common-intellisense/'

export const cacheFetch = new Map()
export const localCacheUri = path.resolve(__dirname, 'mapping.json')
let isCommonIntellisenseInProgress = false
let isRemoteUrisInProgress = false
let isLocalUrisInProgress = false
const retry = 3
const timeout = 600000 // 如果 10 分钟拿不到就认为是 proxy 问题
const isZh = getLocale()?.includes('zh')

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
      logger.info(isZh ? `缓存读取完毕, 已缓存的 key: ${cacheKey}` : `Cache read complete, cached keys: ${cacheKey}`)
    })
  }
  else {
    resolve('done reading')
  }
})

// todo: add result type replace any
export async function fetchFromCommonIntellisense(tag: string) {
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
    }
    else {
      logger.error(`获取最新版本错误: ${String(error)}`)
    }
    return
  }
  logger.info(isZh ? `找到 ${name} 的最新版本: ${version}` : `Found the latest version of ${name}: ${version}`)
  const key = `${name}@${version}`
  // 当版本修改是否要删除相同 name 下的其它版本缓存？
  if (isCommonIntellisenseInProgress)
    return

  let resolver: () => void = () => { }
  let rejecter: (msg?: string) => void = () => { }
  isCommonIntellisenseInProgress = true
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
    const module: any = {}
    const runModule = new Function('module', scriptContent)
    if (scriptContent)
      cacheFetch.set(key, scriptContent)
    runModule(module)
    const moduleExports = module.exports

    const result: any = {}
    for (const key in moduleExports) {
      const v = moduleExports[key]
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
        result[key] = () => propsReducer(v())
      }
    }
    resolver()
    isCommonIntellisenseInProgress = false
    return result
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
    isCommonIntellisenseInProgress = false
    // 尝试从本地获取
    message.error(isZh ? `从远程拉取 UI 包失败 ☹️，请检查代理` : `Failed to pull UI package from remote ☹️, please check the proxy`)
    return fetchFromLocalUris()
    // todo：增加重试机制
  }
}

const tempCache = new Map()
export async function fetchFromRemoteUrls() {
  // 读取 urls
  const uris = getConfiguration('common-intellisense.remoteUris') as string[]
  if (!uris.length)
    return

  const result: any = {}

  if (isRemoteUrisInProgress)
    return

  const fixedUris = (await Promise.all(uris.map(async (name) => {
    const key = `remote-uri:${name}`
    if (tempCache.has(key))
      return ''
    tempCache.set(key, true)
    return name
  }))).filter(Boolean)

  if (!fixedUris.length)
    return

  let resolver: () => void = () => { }
  let rejecter: (msg?: string) => void = () => { }
  isRemoteUrisInProgress = true
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
    const scriptContents = await Promise.all(fixedUris.map(async (uri) => {
      logger.info(isZh ? `正在加载 ${uri}` : `Loading ${uri}`)
      return [uri, cacheFetch.has(uri) ? cacheFetch.get(uri) : await ofetch(uri, { responseType: 'text', retry, timeout })]
    }))
    scriptContents.forEach(([uri, scriptContent]) => {
      const module: any = {}
      const runModule = new Function('module', scriptContent)
      if (scriptContent)
        cacheFetch.set(uri, scriptContent)
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
      Object.assign(result, temp)
    })
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }
  isRemoteUrisInProgress = false

  return result
}

export async function fetchFromRemoteNpmUrls() {
  // 读取 urls
  const uris = getConfiguration('common-intellisense.remoteNpmUris') as ({ name: string, resource?: string } | string)[]
  if (!uris.length)
    return

  const result: any = {}

  if (isRemoteUrisInProgress)
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
        // 说明这个版本还未支持, 可以通过 issue 提出
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
  }))).filter(Boolean) as [string, string, undefined | string][]

  if (!fixedUris.length)
    return

  let resolver: () => void = () => { }
  let rejecter: (msg?: string) => void = () => { }
  isRemoteUrisInProgress = true

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
        return cacheFetch.get(key)

      const scriptContent = await Promise.any([
        fetchAndExtractPackage({ name, dist: 'index.cjs', logger }),
        fetchFromCjsForCommonIntellisense({ name, version, retry }) as Promise<string>,
      ])

      if (scriptContent)
        cacheFetch.set(key, scriptContent)
      return scriptContent
    }))).forEach((scriptContent) => {
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
      Object.assign(result, temp)
    })
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }
  isRemoteUrisInProgress = false

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
      // 如果缓存中已存在，比对内容是否改变，没改变则不再处理，直接过滤
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
