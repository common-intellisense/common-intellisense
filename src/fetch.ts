import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createFakeProgress, getConfiguration, getLocale, getRootPath, message } from '@vscode-use/utils'
import { ofetch } from 'ofetch'
import { latestVersion } from '@simon_he/latest-version'
import { componentsReducer, propsReducer } from './ui/utils'
import { logger } from '.'

const prefix = '@common-intellisense/'

export const cacheFetch = new Map()
export const localCacheUri = path.resolve(__dirname, 'mapping.json')
let isCommonIntellisenseInProgress = false
let isRemoteUrisInProgress = false
let isLocalUrisInProgress = false
const retry = 1
const timeout = 600000 // 如果 10 分钟拿不到就认为是 proxy 问题
const isZh = getLocale()?.includes('zh')
if (existsSync(localCacheUri)) {
  fsp.readFile(localCacheUri, 'utf-8').then((res) => {
    logger.info(isZh ? `正在读取 ${localCacheUri} 中的数据` : `Reading data from ${localCacheUri}`)
    try {
      const oldMap = JSON.parse(res) as [string, string][]
      oldMap.forEach(([key, value]) => {
        cacheFetch.set(key, value)
      })
    }
    catch (error) {
      logger.error(String(error))
    }
  })
}

export async function fetchFromCommonIntellisense(tag: string) {
  const name = prefix + tag
  const version = await latestVersion(name, { cwd: getRootPath(), timeout: 10000 })
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
    logger.info(`key: ${key}`)

    const scriptContent = cacheFetch.has(key)
      ? cacheFetch.get(key)
      : await Promise.any([
        ofetch(`https://cdn.jsdelivr.net/npm/${key}/dist/index.cjs`, { responseType: 'text', retry, timeout }),
        ofetch(`https://unpkg.com/${key}/dist/index.cjs`, { responseType: 'text', retry, timeout }),
      ])
    cacheFetch.set(key, scriptContent)
    const module: any = {}
    const runModule = new Function('module', scriptContent)
    runModule(module)
    const moduleExports = module.exports
    const result: any = {}
    const isZh = getLocale()!.includes('zh')
    for (const key in moduleExports) {
      const v = moduleExports[key]
      if (key.endsWith('Components')) {
        result[key] = () => componentsReducer(v(isZh))
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

export async function fetchFromRemoteUrls() {
  // 读区 urls
  const uris = getConfiguration('common-intellisense.remoteUris') as string[]
  if (!uris.length)
    return

  const result = {}

  if (isRemoteUrisInProgress)
    return

  let resolver!: () => void
  let rejecter!: (msg?: string) => void
  isRemoteUrisInProgress = true
  createFakeProgress({
    title: isZh ? `正在拉取远程文件` : 'Pulling remote files',
    message: v => isZh ? `已完成 ${v}%` : `Completed ${v}%`,
    callback(resolve, reject) {
      resolver = resolve
      rejecter = reject
    },
  })

  try {
    const scriptContents = await Promise.all(uris.map(async uri => [uri, cacheFetch.has(uri) ? cacheFetch.get(uri) : await ofetch(uri, { responseType: 'text', retry, timeout })]))
    scriptContents.forEach(([uri, scriptContent]) => {
      const module: any = {}
      const runModule = new Function('module', scriptContent)
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

export async function fetchFromLocalUris() {
  let uris = getConfiguration('common-intellisense.localUris') as string[]
  if (!uris.length)
    return
  logger.info(`localUris: ${uris}`)
  // 查找本地文件 是否存在
  const result = {}
  uris = uris.map((uri) => {
    // 如果是相对路径，转换为绝对路径，否则直接用
    if (uri.startsWith('./'))
      uri = path.resolve(getRootPath()!, uri)

    if (cacheFetch.has(uri) || existsSync(uri)) {
      return uri
    }
    else {
      logger.error(isZh ? `加载本地文件不存在: [${uri}]` : `Local file does not exist: [${uri}]`)
      return false
    }
  }).filter(Boolean) as string[]

  if (!uris.length)
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
    await Promise.all(uris.map(async (uri) => {
      if (cacheFetch.has(uri)) {
        Object.assign(result, cacheFetch.get(uri))
        return
      }
      const module: any = {}
      const scriptContent = await fsp.readFile(uri, 'utf-8')
      cacheFetch.set(uri, scriptContent)
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
    }))
    resolver()
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }

  isLocalUrisInProgress = false
  return result
}
