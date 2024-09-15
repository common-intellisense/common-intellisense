// import { getConfiguration } from "@vscode-use/utils";
import { ofetch } from 'ofetch'
import { latestVersion } from '@simon_he/latest-version'
import { createFakeProgress, getLocale } from '@vscode-use/utils'
import { componentsReducer, propsReducer } from './ui/utils'
import { logger } from '.'

const prefix = '@common-intellisense/'
const cacheFetch = new Map()
export async function fetchFromCommonIntellisense(tag: string) {
  const name = prefix + tag
  const version = latestVersion(name)
  const key = `${name}@${version}`
  // 当版本修改是否要删除相同 name 下的其它版本缓存？
  if (cacheFetch.has(key))
    return cacheFetch.get(key)

  let resolver!: () => void
  let rejecter!: (msg?: string) => void
  createFakeProgress({
    title: `正在拉取远程的 ${tag}`,
    message: v => `已完成 ${v}%`,
    callback: (resolve, reject) => {
      resolver = resolve
      rejecter = reject
    },
  })
  try {
    logger.info(`key: ${key}`)
    const scriptContent = await Promise.any([
      ofetch(`https://cdn.jsdelivr.net/npm/${key}/dist/index.cjs`, { responseType: 'text' }),
      ofetch(`https://unpkg.com/${key}/dist.index.cjs`, { responseType: 'text' }),
    ])
    logger.info(`scriptContent: ${scriptContent}`)
    const module: any = {}
    const runModule = new Function('module', scriptContent)
    runModule(module)
    // const module = await import(`data:text/javascript,${encodeURIComponent(scriptContent)}`)
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
    logger.info(JSON.stringify(moduleExports))
    cacheFetch.set(key, result)
    resolver()
    return result
  }
  catch (error) {
    rejecter(String(error))
    logger.error(String(error))
  }
}

// todo: readConfigRemoteUris
// export function fetchFromRemoteUrls() {
//   // 读区 urls
//   const uris = getConfiguration('common-intellisense.remoteUris')
//   if (!uris.length)
//     return
// }
