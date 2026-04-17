import type { CompletionItemOptions } from '@vscode-use/utils'
import type { CompletionItem } from 'vscode'
import type { Component, Slots, SuggestionItem } from './ui-type'
import { camelize, compareVersion, isContainCn, reduceAsync, replaceAsync } from 'lazy-js-utils'
import { createCompletionItem, createHover, createMarkdownString, getActiveTextEditorLanguageId, getConfiguration, getCurrentFileUrl, getLocale, getRootPath, setCommandParams } from '@vscode-use/utils'
import * as vscode from 'vscode'
import { translate } from '../translate'
import { resolveInstalledPackageVersion } from '../services/package-version'
import { logger } from '../ui/ui-find'

export interface PropsOptions {
  uiName: string
  lib: string
  map: Component[]
  extensionContext?: vscode.ExtensionContext
  prefix?: string
  dynamicLib?: string
}

export type IconsItem = any
export type Icons = IconsItem[]
export type SubCompletionItem = CompletionItem & {
  content: string
  params?: FixParams
  hover?: vscode.Hover
  loc?: vscode.Range
  snippet?: string
  details?: string
  propType?: string
}
export interface PropsConfigItem {
  icons?: SubCompletionItem[] | vscode.CompletionList<SubCompletionItem> | PromiseLike<SubCompletionItem[] | vscode.CompletionList<SubCompletionItem> | null | undefined> | null | undefined
  completions: ((isVue?: boolean) => SubCompletionItem[])[]
  events: ((isVue?: boolean) => SubCompletionItem[])[]
  methods: SubCompletionItem[]
  exposed: SubCompletionItem[]
  slots: SubCompletionItem[]
  suggestions: (string | SuggestionItem)[]
  tableDocument: vscode.MarkdownString
  rawSlots?: Slots
  uiName: string
  lib: string
}

export interface FixParams {
  data: Component
  lib: string
  isReact: boolean
  prefix: string
  dynamicLib: string
  importWay: string
}

export type PropsConfig = Record<string, PropsConfigItem> & { icons?: Icons }

export function proxyCreateCompletionItem(options: CompletionItemOptions & {
  params?: string | string[]
}): SubCompletionItem {
  return createCompletionItem(options)
}

const cwd = getRootPath()
export function propsReducer(options: PropsOptions) {
  const { uiName, lib, map, prefix = '', dynamicLib } = options

  const result: PropsConfig = {}
  // 不再支持 icon, 或者考虑将 icon 生成字体图标，产生预览效果
  // let icons
  // if (iconData) {
  //   const prefix = iconData.prefix
  //   icons = iconData.icons.map((icon) => {
  //     const imagePath = vscode.Uri.file(extensionContext.asAbsolutePath(`images/${iconData.type}/${icon}.svg`))
  //     const documentation = new vscode.MarkdownString(`![img](${imagePath})`)
  //     const snippet = `${prefix}-${icon}`
  //     return createCompletionItem({ content: icon, type: 19, documentation, snippet, params: [uiName] })
  //   })
  //   result.icons = icons
  // }
  let localVersion: string | undefined

  return reduceAsync(map, async (result, item: Component) => {
    const completions: ((isVue?: boolean) => SubCompletionItem[])[] = []
    const events: ((isVue?: boolean) => SubCompletionItem[])[] = []
    const methods: SubCompletionItem[] = []
    const exposed: SubCompletionItem[] = []
    const slots: SubCompletionItem[] = []
    const isZh = getLocale().includes('zh')
    if (!localVersion) {
      // 从本地安装去获取版本号，如果获取不到根据 uiName 后缀获取版本号，再找不到就是 0.0.0
      localVersion = await resolveInstalledPackageVersion(lib, cwd) || uiName.match(/\d+(\.\d+\.\d+)?/)?.[0] || '0.0.0'
    }

    if (item.version) {
      // 过滤在某个版本才增加的新组件
      if (localVersion && compareVersion(localVersion, item.version) === -1) {
        return result
      }
    }

    const completionsDeferCallback = (isVue?: any) => {
      const data: SubCompletionItem[] = [
        'id',
        isVue ? 'class' : 'className',
        'ref',
      ].map(item => proxyCreateCompletionItem({ content: item, snippet: `${item}="\${1:}"`, type: 5, params: [] }))

      if (isVue)
        data.push(proxyCreateCompletionItem({ content: 'style', snippet: 'style="$1"', type: 5, params: [] }))
      else
        data.push(proxyCreateCompletionItem({ content: 'style', snippet: 'style={$1}', type: 5, params: [] }))

      // 过滤 props 中有 version 并且当前版本小于组件版本的属性
      const filterProps = localVersion
        ? Object.keys(item.props || {}).reduce((result, key) => {
            const value = (item.props as any)[key]
            // value.version 只提取版本号
            const version = value.version?.match(/\d+\.\d+\.\d+/)?.[0]
            if (version && compareVersion(version, localVersion!) === -1) {
              return result
            }
            return { ...result, [key]: value }
          }, {})
        : item.props

      Object.keys(filterProps).forEach((key) => {
        const value = (item.props as any)[key]
        let type = vscode.CompletionItemKind.Property
        if (typeof value.value !== 'string')
          type = vscode.CompletionItemKind.Enum

        const documentation = new vscode.MarkdownString()
        documentation.isTrusted = true
        documentation.supportHtml = true
        const detail = []

        detail.push(`## ${uiName} [${item.name}]`)

        if (value.default !== undefined && value.default !== '') {
          value.default = String(value.default)
          detail.push(`#### 💎 ${isZh ? '默认值' : 'default'}:    ***\`${value.default.replace(/[`\n]/g, '')}\`***`)
        }

        if (value.version) {
          if (isZh)
            detail.push(`#### 🚀 版本:    ***\`${value.version}\`***`)
          else
            detail.push(`#### 🚀 version:    ***\`${value.version}\`***`)
        }

        if (value.platform) {
          detail.push(`#### 🚀 平台:   ***\`${value.platform}\`***`)
        }

        if (value.description) {
          if (isZh)
            detail.push(`#### 🔦 说明:    ***\`${value.description_zh || value.description}\`***`)
          else
            detail.push(`#### 🔦 description:    ***\`${value.description}\`***`)
        }

        if (value.type) {
          if (Array.isArray(value.type)) {
            value.type = value.type.join(' / ')
          }
          detail.push(`#### 💡 ${isZh ? '类型' : 'type'}:    ***\`${value.type.replace(/`/g, '')}\`***`)
        }

        documentation.appendMarkdown(detail.join('\n\n'))

        const typeDetail = value.typeDetail || item.typeDetail
        if (typeDetail && Object.keys(typeDetail).length) {
          const data = `🌈 类型详情:\n${Object.keys(typeDetail).reduce((result, key) => {
            if (Array.isArray(typeDetail[key])) {
              return result += key[0] === '$'
                ? `\ntype ${key.slice(1).replace(/-(\w)/g, v => v.toUpperCase())} = \n${typeDetail[key].map((typeItem: any) => `${typeItem.name} /*${typeItem.description}*/`).join('\n| ')}\n\n`
                : `\ninterface ${key} {\n  ${typeDetail[key].map((typeItem: any) => `${typeItem.name}${typeItem.optional ? '?' : ''}: ${typeItem.type} /*${typeItem.description}${String(typeItem.default) ? ` 默认值: ***${String(typeItem.default).replace(/\n/g, '')}***` : ''}*/`).join('\n  ')}\n}`
            }
            return result += `\n${typeDetail[key].split('|').join('\n|')}`
          }, '')}`
          documentation.appendCodeblock(data, 'typescript')
        }

        // command:extension.openDocumentLink?%7B%22link%22%3A%22https%3A%2F%2Fexample.com%2F%22%7D
        if (item.link)
          documentation.appendMarkdown(`\n[🔗 ${isZh ? '文档链接' : 'Documentation link'}](command:intellisense.openDocument?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D)\`       \`[🔗 ${isZh ? '外部文档链接' : 'External document links'}](command:intellisense.openDocumentExternal?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D)`)

        let content = ''
        let snippet = ''

        let _prefix = ''
        let _prefixKey = ''
        if (isVue && value.related && value.related.length) {
          for (const _item of value.related) {
            ;[_prefix, _prefixKey] = findValue(isVue, _item)
            if (prefix)
              break
          }
        }
        if (prefix && value[`$${_prefixKey}`]) {
          const prefixValue = value[`$${_prefixKey}`].replace(`$${_prefixKey}`, _prefix)
          // 替换 $()
          const fixedPrefixValue = prefixValue.replace(/\$\(([^)]+)\)/g, (_: string, m: string) => {
            // m 可能存在 xxx.a || xxx.b 的情况
            for (const splitItem of m.split(/\s*\|\|\s*/)) {
              const [_prefix, _prefixKey] = findValue(isVue, splitItem)
              if (_prefix) {
                let result = _prefix
                if (isContainCn(result)) {
                  result = `\${1:${result}}`
                }
                return result ? `${result[0].toLocaleLowerCase()}${camelize(result.slice(1))}` : result
              }
            }
            return ''
          })
          content = key
          if (fixedPrefixValue === `${_prefix}.`) {
            const fixedKey = key.replace(/^:/, '')
            snippet = `${key}="${prefix}.${fixedKey[0].toUpperCase()}${fixedKey.slice(1)}"`
          }
          else {
            snippet = `${key}="${fixedPrefixValue}"`
          }
        }
        else if (Array.isArray(value.value)) {
          content = key
          snippet = `${key}="\${1|${value.value.map((i: string) => i.replace(/['`\s]/g, '').replace(/,/g, '\\,')).join(',')}|}"`
        }
        else if (value.value) {
          content = key
          snippet = `${key}="${value.value}"`
        }
        else if (value.type && value.type.toLowerCase().trim() === 'boolean' && value.default === 'false') {
          content = snippet = key
        }
        else if (value.type && value.type.toLowerCase().trim() === 'boolean' && value.default === 'true') {
          if (isVue) {
            content = key
            snippet = `:${key}="false"`
          }
          else {
            content = key
            snippet = `${key}={false}`
          }
        }
        else if (key.startsWith(':')) {
          if (isVue) {
            const _key = key.replace('v-model', 'model')
            content = `${key.replace(':v-model', 'v-model')}="${getComponentTagName(item.name)}${_key[1].toUpperCase()}${toCamel(_key.slice(2))}"`
            snippet = `${key.replace(':v-model', 'v-model')}="\${1|${generateSnippetNameOptions(item, _key, prefix)}|}"$2`
          }
          else {
            content = `${key.slice(1)}={${getComponentTagName(item.name)}${key[1].toUpperCase()}${toCamel(key.slice(2))}}`
            snippet = `${key.slice(1)}={\${1|${generateSnippetNameOptions(item, key, prefix)}|}}$2`
          }
        }
        else {
          content = `${key}=""`

          if (value.type.includes('/'))
            snippet = `${key}="\${1|${value.type.split('/').map((i: string) => i.replace(/['`\s]/g, '').replace(/,/g, '\\,')).join(',')}|}"`
          else
            snippet = `${key}="\${1}"`
        }
        const detailsLines: string[] = []
        detailsLines.push(`${isZh ? '***属性***' : '***prop***'}: ${content}`)
        if (value.description_zh || value.description) {
          detailsLines.push(isZh
            ? `***描述***: ${value.description_zh || value.description}`
            : `***description***: ${value.description}`)
        }
        if (value.default !== undefined && value.default !== '') {
          detailsLines.push(isZh
            ? `***默认***: ${value.default.replace(/\n/g, '')}`
            : `***default***: ${value.default.replace(/\n/g, '')}`)
        }
        if (value.type) {
          detailsLines.push(isZh
            ? `***类型***: ${value.type.replace(/\n/g, '')}`
            : `***type***: ${value.type.replace(/\n/g, '')}`)
        }
        const details = detailsLines.join('\n-  ')
        const propDesc = isZh ? (value.description_zh || value.description) : value.description
        if (propDesc)
          content += `  ${propDesc}`
        if (value.default)
          content += `  ${isZh ? '默认' : 'default'}：${value.default.replace(/\n/g, '')}`
        data.push(createCompletionItem({
          content,
          details,
          snippet,
          type,
          documentation,
          preselect: true,
          sortText: '0',
          params: [uiName, key.replace(/^:/, '')],
          propType: Array.isArray(value.value) ? value.value.join(' / ') : value.type,
          command: {
            command: 'editor.action.triggerSuggest', // 这个命令会触发代码提示
            title: 'Trigger Suggest',
          },
        }))
      })
      return data
    }

    completions.push(completionsDeferCallback)

    if (!item.events)
      item.events = []

    if (item.events) {
      const deferEventsCall = (isVue?: boolean) => {
        const lan = getActiveTextEditorLanguageId()
        const originEvent = [
          {
            name: isVue
              ? 'click'
              : lan === 'svelte'
                ? 'onclick'
                : 'onClick',
            description: 'click event',
            description_zh: '点击事件',
            params: [],
          },
        ]

        originEvent.forEach((_event) => {
          if (!item.events.find(event => event.name === _event.name))
            item.events.push(_event)
        })

        // 过滤在某个版本才增加的新事件
        const filterEvents = localVersion
          ? item.events.filter((event) => {
              const version = event.version?.match(/\d+\.\d+\.\d+/)?.[0]
              return !(version && compareVersion(version, localVersion!) === -1)
            })
          : item.events

        return filterEvents.map((events: any) => {
          const detail: string[] = []
          const { name, description, params, description_zh, platform } = events

          detail.push(`## ${uiName} [${item.name}]`)

          if (description) {
            if (isZh)
              detail.push(`#### 🔦 说明:    ***\`${description_zh || description}\`***`)
            else
              detail.push(`#### 🔦 description:    ***\`${description}\`***`)
          }

          if (platform)
            detail.push(`#### 🚀 平台:    ***\`${platform}\`***`)

          if (params)
            detail.push(`#### 🔮 ${isZh ? '回调参数' : 'callback parameters'}:    ***\`${params}\`***`)

          let snippet
          let content
          if (isVue) {
            const [snippetEventNameOptions, _name] = generateScriptNames(name)
            snippet = `${name}="\${1|${snippetEventNameOptions.join(',')}|}"`
            content = `@${name}="on${_name}"`
          }
          else if (lan === 'svelte') {
            snippet = `${name}={\${1:${name.replace(/:(\w)/, (_: string, v: string) => v.toUpperCase())}}}`
            content = `${name}={${name.replace(/:(\w)/, (_: string, v: string) => v.toUpperCase())}}`
          }
          else {
            const [snippetEventNameOptions, _name] = generateScriptNames(name)
            snippet = `${name}={\${1|${snippetEventNameOptions.join(',')}|}}`
            content = `${name}={${_name}}`
          }

          const eventDesc = isZh ? (description_zh || description) : description
          if (eventDesc)
            content += `  ${eventDesc}`
          if (params)
            content += `  ${isZh ? '参数' : 'params'}：${params}`
          const detailsLines: string[] = []
          detailsLines.push(`${isZh ? '***属性***' : '***prop***'}: ${content}`)
          if (eventDesc) {
            detailsLines.push(isZh
              ? `***描述***: ${description_zh || description}`
              : `***description***: ${description}`)
          }
          if (typeof params === 'string' && params) {
            detailsLines.push(isZh
              ? `***参数***: ${params.replace(/\n/g, '')}`
              : `***params***: ${params.replace(/\n/g, '')}`)
          }
          const details = detailsLines.join('\n-  ')
          const documentation = new vscode.MarkdownString()
          documentation.isTrusted = true
          documentation.supportHtml = true
          documentation.appendMarkdown(detail.join('\n\n'))
          return proxyCreateCompletionItem({ content, snippet, details, documentation, type: vscode.CompletionItemKind.Event, sortText: '0', preselect: true, params: [uiName, name] })
        },
        )
      }
      events.push(deferEventsCall)
    }

    if (item.methods) {
      const filterMethods = localVersion
        ? item.methods.filter((item) => {
          // 过滤在某个版本才增加的新方法
            const version = item.version?.match(/\d+\.\d+\.\d+/)?.[0]
            return !(version && compareVersion(version, localVersion!) === -1)
          })
        : item.methods
      methods.push(...filterMethods.map((method) => {
        const documentation = new vscode.MarkdownString()
        documentation.isTrusted = true
        documentation.supportHtml = true
        const detail: string[] = []
        const { name, description, params, description_zh } = method

        detail.push(`## ${uiName} [${item.name}]`)

        if (name)
          detail.push(`\n#### 💨 ${isZh ? '方法' : 'method'} ${name}:`)

        if (description) {
          if (isZh)
            detail.push(`- 👓 说明:    ***\`${description_zh || description}\`***`)
          else
            detail.push(`- 👓 description:    ***\`${description}\`***`)
        }

        if (params)
          detail.push(`- 🚢 ${isZh ? '参数' : 'params'}:    ***\`${params}\`***`)

        documentation.appendMarkdown(detail.join('\n\n'))
        const hover = createHover(documentation)
        return proxyCreateCompletionItem({ content: method.name, snippet: `${name.endsWith('()') ? name : `${name}()`}$1`, documentation, type: 1, sortText: '0', params: uiName, hover })
      }))
    }

    if (item.exposed) {
      const filterExposed = localVersion
        ? item.exposed.filter((item) => {
          // 过滤在某个版本才增加的新方法
            const version = item.version?.match(/\d+\.\d+\.\d+/)?.[0]
            return !(version && compareVersion(version, localVersion!) === -1)
          })
        : item.exposed
      exposed.push(...filterExposed.map((expose) => {
        const documentation = new vscode.MarkdownString()
        documentation.isTrusted = true
        documentation.supportHtml = true
        const details: string[] = []
        const { name, description, detail, description_zh } = expose

        details.push(`## ${uiName} [${item.name}]`)

        if (name)
          details.push(`\n#### 💨 ${isZh ? '导出' : 'exposed'} ${name}:`)

        if (description) {
          if (isZh)
            details.push(`- 👓 说明:    ***\`${description_zh || description}\`***`)
          else
            details.push(`- 👓 description:    ***\`${description}\`***`)
        }

        if (detail)
          details.push(`- 🚢 ${isZh ? '详情' : 'detail'}:    ***\`${detail}\`***`)

        documentation.appendMarkdown(details.join('\n\n'))
        const hover = createHover(documentation)
        return proxyCreateCompletionItem({ content: expose.name, snippet: expose.detail.startsWith('()') ? `${expose.name}()` : expose.name, detail, documentation, type: 1, sortText: 'a', preselect: true, params: uiName, hover })
      }))
    }

    if (item.slots) {
      const filterSlots = localVersion
        ? item.slots.filter((item) => {
          // 过滤在某个版本才增加的新方法
            const version = item.version?.match(/\d+\.\d+\.\d+/)?.[0]
            return !(version && compareVersion(version, localVersion!) === -1)
          })
        : item.slots
      filterSlots.forEach((slot) => {
        const { name, description, description_zh } = slot
        const documentation = new vscode.MarkdownString()
        documentation.isTrusted = true
        documentation.supportHtml = true
        const detail = []
        if (description) {
          if (isZh)
            detail.push(`- 👓 说明:    ***\`${description_zh || description}\`***`)
          else
            detail.push(`- 👓 description:    ***\`${description}\`***`)
        }
        documentation.appendMarkdown(detail.join('\n\n'))

        slots.push(createCompletionItem({ content: `slot="${name}"`, snippet: `slot="${name}"$1`, documentation, type: 1, preselect: true, sortText: 'b', params: uiName }))
      })
    }

    const createTableDocument = () => {
      const documentation = createMarkdownString()
      documentation.isTrusted = true
      documentation.supportHtml = true
      const details: string[] = []
      let text = `## ${uiName} [${item.name}]`
      if (item.link) {
        text += `\`            \`[🔗 ${isZh ? '文档链接' : 'Documentation link'}](command:intellisense.openDocument?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D)\`   \`[🔗 ${isZh ? '外部链接' : 'External document links'}](command:intellisense.openDocumentExternal?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D) \`            \` [🌟 Star!](https://github.com/common-intellisense/common-intellisense) \`            \` [❤️ Sponsor!](https://github.com/Simon-He95/sponsor)`
      }
      details.push(text)

      if (item.props) {
        if (isZh)
          details.push('### 参数:')
        else
          details.push('### Props:')

        const tableHeader = `| ${isZh ? '属性名' : 'Name'} | ${isZh ? '描述' : 'Description'} | ${isZh ? '类型' : 'Type'} | ${isZh ? '默认值' : 'Default'} |`
        const tableDivider = '| --- | --- | --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...Object.keys(item.props).map((name) => {
            const { default: defaultValue = '', type, description, description_zh } = item.props[name]
            let value = String(defaultValue).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
            value = String(defaultValue).length > 20 ? '...' : value
            const safeType = String(type).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|').replace(/\n/g, ' ')
            return `| \`${name}\` | \`${safeDescription}\` | \`${safeType || ''}\` | \`${value || ''}\` |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (item.methods && item.methods.length) {
        if (isZh)
          details.push('## 方法:')
        else
          details.push('## Methods:')

        const tableHeader = `| ${isZh ? '方法名' : 'Method Name'} | ${isZh ? '描述' : 'Description'} | ${isZh ? '参数' : 'Params'} |`
        const tableDivider = '| --- | --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...item.methods.map((m) => {
            const { name, params, description, description_zh } = m
            const safeName = String(name).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|')
            const safeParams = params ? String(params).replace(/\|/g, '\\|') : ''
            return `| ${safeName} | ${safeDescription} | ${safeParams} |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (item.events && item.events.length) {
        if (isZh)
          details.push('## 事件:')
        else
          details.push('## Events:')

        const tableHeader = `| ${isZh ? '事件名' : 'Event Name'} | ${isZh ? '描述' : 'Description'} | ${isZh ? '参数' : 'Params'} |`
        const tableDivider = '| --- | --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...item.events.map((m) => {
            const { name, params, description, description_zh } = m
            const safeName = String(name).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|')
            const safeParams = params ? String(params).replace(/\|/g, '\\|') : '-'
            return `| ${safeName} | ${safeDescription} | ${safeParams} |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (item.slots && item.slots.length) {
        if (isZh)
          details.push('## 插槽:')
        else
          details.push('## Slots:')

        const tableHeader = `| ${isZh ? '插槽名' : 'Slot Name'} | ${isZh ? '描述' : 'Description'} |`
        const tableDivider = '| --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...item.slots.map((m) => {
            const { name, description, description_zh } = m
            const safeName = String(name).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|')
            return `| \`${safeName}\` | ${safeDescription} |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (item.link)
        details.push(`[🔗 ${isZh ? '文档链接' : 'Documentation link'}](command:intellisense.openDocument?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D)\`        \` [🔗 ${isZh ? '外部链接' : 'External document links'}](command:intellisense.openDocumentExternal?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D)`)

      documentation.appendMarkdown(details.join('\n\n'))
      return documentation
    }
    const tableDocument = createTableDocument()
    const name = item.name.split('.')[0]
    const from = (item.dynamicLib || dynamicLib) ? (dynamicLib || item.dynamicLib)!.replace('${name}', hyphenate(name)) : lib
    result[item.name!] = { completions, events, methods, exposed, slots, suggestions: item.suggestions || [], tableDocument, rawSlots: item.slots, uiName, lib: from }
    return result
  }, result)
}
export type Directives = {
  name: string
  description: string
  description_zh: string
  documentation?: string
  documentationType?: string
  params?: {
    name: string
    description: string
    description_zh: string
    type: string
    default: string
  }[]
  link: string
  link_zh: string
}[]

// todo: 重构参数，参数过多，改为 options
export interface ComponentOptions {
  map: any[]
  isSeperatorByHyphen?: boolean
  prefix?: string
  lib: string
  isReact?: boolean
  dynamicLib?: string
  importWay?: 'as default' | 'default' | 'specifier'
  directives?: Directives
}

export interface ComponentsConfigItem {
  prefix: string
  directives?: Directives
  lib: string
  data: () => Promise<CompletionItem>[]
  isReact?: boolean
  dynamicLib?: string
  importWay?: 'as default' | 'default' | 'specifier'
}

export type ComponentsConfig = ComponentsConfigItem[]
export function componentsReducer(options: ComponentOptions): ComponentsConfig {
  let { map, isSeperatorByHyphen = true, prefix = '', lib, isReact = false, dynamicLib, importWay = 'specifier', directives } = options
  const isZh = getLocale().includes('zh')

  if (!isReact && prefix) {
    return [
      {
        prefix,
        directives,
        lib,
        data: (parent?: any) => (map as [Component | string, string, string?][]).map(async ([content, detail, demo]) => {
          const isVue = isVueOrVine()
          let snippet = ''
          let _content = ''
          let description = ''
          if (typeof content === 'object') {
            if (content.dynamicLib)
              dynamicLib = content.dynamicLib
            if (content.importWay)
              importWay = content.importWay

            const tag = isSeperatorByHyphen ? hyphenate(content.name) : content.name
            snippet = await getTemplateStr(map, content, 0, isVue, isSeperatorByHyphen, parent)
            _content = `${tag}  ${content.tag || detail}`
            description = isZh && content.description_zh ? content.description_zh : content.description || ''
          }
          else {
            snippet = `<${content}$1>$2</${content}>`
            _content = `${content}  ${detail}`
          }
          if (!demo)
            demo = snippet
          const documentation = new vscode.MarkdownString()
          documentation.isTrusted = true
          documentation.supportHtml = true

          documentation.appendMarkdown(`#### 🍀 ${lib} ${detail}\n`)
          if (typeof content === 'object' && content.suggestions?.length) {
            documentation.appendMarkdown(`\n#### 👗 ${isZh ? '常用搭配' : 'Common collocation'} \n`)
            // FIXME: suggestions的Item有对象形式的vant4里面,里面的文案要怎么展示
            documentation.appendMarkdown(`${content.suggestions.map((item: string | SuggestionItem) => `- ${item}`).join('\n')}\n`)
          }
          const copyIcon = '<img width="12" height="12" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMjQgMjQiPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2UyOWNkMCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2Utd2lkdGg9IjEuNSI+PHBhdGggZD0iTTIwLjk5OCAxMGMtLjAxMi0yLjE3NS0uMTA4LTMuMzUzLS44NzctNC4xMjFDMTkuMjQzIDUgMTcuODI4IDUgMTUgNWgtM2MtMi44MjggMC00LjI0MyAwLTUuMTIxLjg3OUM2IDYuNzU3IDYgOC4xNzIgNiAxMXY1YzAgMi44MjggMCA0LjI0My44NzkgNS4xMjFDNy43NTcgMjIgOS4xNzIgMjIgMTIgMjJoM2MyLjgyOCAwIDQuMjQzIDAgNS4xMjEtLjg3OUMyMSAyMC4yNDMgMjEgMTguODI4IDIxIDE2di0xIi8+PHBhdGggZD0iTTMgMTB2NmEzIDMgMCAwIDAgMyAzTTE4IDVhMyAzIDAgMCAwLTMtM2gtNEM3LjIyOSAyIDUuMzQzIDIgNC4xNzIgMy4xNzJDMy41MTggMy44MjUgMy4yMjkgNC43IDMuMTAyIDYiLz48L2c+PC9zdmc+" />'
          documentation.appendMarkdown(`#### 🌰 ${isZh ? '例子' : 'example'}\n`)
          documentation.appendCodeblock(demo, 'html')
          // FIXME: 要求输入数组，但是demo类型是字符串，但是都通过JSON.stringify处理了，所以这里转成[demo]?
          const params = setCommandParams(demo as any)
          documentation.appendMarkdown(`\n<a href="command:intellisense.copyDemo?${params}">${copyIcon}</a>\n`)

          // FIXME: params要求string| string[]
          // const fixParams: FixParams = [content as Component, lib, isReact, prefix, dynamicLib || '', importWay || '']
          const fixParams: any = {
            data: content,
            lib,
            isReact,
            prefix,
            dynamicLib,
            importWay,
          }
          return createCompletionItem({ content: _content, preselect: true, snippet, detail: description, documentation, type: vscode.CompletionItemKind.TypeParameter, sortText: '0', params: fixParams, demo })
        }),
      },
      {
        prefix: '',
        directives,
        lib,
        data: (parent?: any) => (map as [Component | string, string, string?][]).map(async ([content, detail, demo]) => {
          const isVue = isVueOrVine()
          let snippet = ''
          let _content = ''
          let description = ''
          if (typeof content === 'object') {
            snippet = await getTemplateStr(map, content, 0, isVue, isSeperatorByHyphen, parent)
            const tag = content.name.slice(prefix.length)
            _content = `${tag}  ${content.tag || detail}`
            description = isZh && content.description_zh ? content.description_zh : content.description || ''
          }
          else {
            snippet = `<${content}$1>$2</${content}>`
            _content = `${content}  ${detail}`
          }
          if (!demo)
            demo = snippet
          const documentation = new vscode.MarkdownString()
          documentation.isTrusted = true
          documentation.supportHtml = true
          documentation.appendMarkdown(`#### 🍀 ${lib} ${detail}\n`)
          if (typeof content === 'object' && content.suggestions?.length) {
            documentation.appendMarkdown(`\n#### 👗 ${isZh ? '常用搭配' : 'Common collocation'} \n`)
            documentation.appendMarkdown(`${content.suggestions.map((item: string | SuggestionItem) => `- ${typeof item === 'string' ? item : item.name}`).join('\n')}\n`)
          }
          const copyIcon = '<img width="12" height="12" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMjQgMjQiPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2UyOWNkMCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2Utd2lkdGg9IjEuNSI+PHBhdGggZD0iTTIwLjk5OCAxMGMtLjAxMi0yLjE3NS0uMTA4LTMuMzUzLS44NzctNC4xMjFDMTkuMjQzIDUgMTcuODI4IDUgMTUgNWgtM2MtMi44MjggMC00LjI0MyAwLTUuMTIxLjg3OUM2IDYuNzU3IDYgOC4xNzIgNiAxMXY1YzAgMi44MjggMCA0LjI0My44NzkgNS4xMjFDNy43NTcgMjIgOS4xNzIgMjIgMTIgMjJoM2MyLjgyOCAwIDQuMjQzIDAgNS4xMjEtLjg3OUMyMSAyMC4yNDMgMjEgMTguODI4IDIxIDE2di0xIi8+PHBhdGggZD0iTTMgMTB2NmEzIDMgMCAwIDAgMyAzTTE4IDVhMyAzIDAgMCAwLTMtM2gtNEM3LjIyOSAyIDUuMzQzIDIgNC4xNzIgMy4xNzJDMy41MTggMy44MjUgMy4yMjkgNC43IDMuMTAyIDYiLz48L2c+PC9zdmc+" />'
          documentation.appendMarkdown(`#### 🌰 ${isZh ? '例子' : 'example'}\n`)
          documentation.appendCodeblock(demo, 'html')
          // FIXME: 同上
          const params = setCommandParams(demo as any)
          documentation.appendMarkdown(`\n<a href="command:intellisense.copyDemo?${params}">${copyIcon}</a>\n`)

          // FIXME: params要求string| string[]
          const fixParams: any = {
            data: { ...(content as any), name: (content as any).name?.slice(prefix.length) },
            lib,
            isReact: true,
            prefix,
            dynamicLib,
            importWay,
          }
          // const fixParams: any = [{ ...(content as any), name: (content as any).name?.slice(prefix.length) }, lib, true, prefix, dynamicLib, importWay]
          return createCompletionItem({ content: _content, detail: description, snippet, documentation, type: vscode.CompletionItemKind.TypeParameter, sortText: '0', params: fixParams, demo })
        }),
      },
    ]
  }
  return [{
    prefix,
    directives,
    lib,
    data: (parent?: any) => (map as [Component | string, string, string?][]).map(async ([content, detail, demo]) => {
      const isVue = isVueOrVine()
      let snippet = ''
      let _content = ''
      let description = ''
      if (typeof content === 'object') {
        if (content.dynamicLib)
          dynamicLib = content.dynamicLib
        if (content.importWay)
          importWay = content.importWay
        snippet = await getTemplateStr(map, content, 0, isVue, isSeperatorByHyphen, parent)
        const tag = isSeperatorByHyphen ? hyphenate(content.name) : content.name
        _content = `${tag}  ${content.tag || detail}`
        description = isZh && content.description_zh ? content.description_zh : content.description || ''
      }
      else {
        snippet = `<${content}$1>$2</${content}>`
        _content = `${content}  ${detail}`
      }
      if (!demo)
        demo = snippet

      const documentation = new vscode.MarkdownString()
      documentation.isTrusted = true
      documentation.supportHtml = true
      documentation.appendMarkdown(`#### 🍀 ${lib} ${detail}\n`)
      if (typeof content === 'object' && content.suggestions?.length) {
        documentation.appendMarkdown(`\n#### 👗 ${isZh ? '常用搭配' : 'Common collocation'} \n`)
        documentation.appendMarkdown(`${content.suggestions.map((item: string | SuggestionItem) => `- ${typeof item === 'string' ? item : item.name}`).join('\n')}\n`)
      }
      const copyIcon = '<img width="12" height="12" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMjQgMjQiPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2UyOWNkMCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2Utd2lkdGg9IjEuNSI+PHBhdGggZD0iTTIwLjk5OCAxMGMtLjAxMi0yLjE3NS0uMTA4LTMuMzUzLS44NzctNC4xMjFDMTkuMjQzIDUgMTcuODI4IDUgMTUgNWgtM2MtMi44MjggMC00LjI0MyAwLTUuMTIxLjg3OUM2IDYuNzU3IDYgOC4xNzIgNiAxMXY1YzAgMi44MjggMCA0LjI0My44NzkgNS4xMjFDNy43NTcgMjIgOS4xNzIgMjIgMTIgMjJoM2MyLjgyOCAwIDQuMjQzIDAgNS4xMjEtLjg3OUMyMSAyMC4yNDMgMjEgMTguODI4IDIxIDE2di0xIi8+PHBhdGggZD0iTTMgMTB2NmEzIDMgMCAwIDAgMyAzTTE4IDVhMyAzIDAgMCAwLTMtM2gtNEM3LjIyOSAyIDUuMzQzIDIgNC4xNzIgMy4xNzJDMy41MTggMy44MjUgMy4yMjkgNC43IDMuMTAyIDYiLz48L2c+PC9zdmc+" />'
      documentation.appendMarkdown(`#### 🌰 ${isZh ? '例子' : 'example'}\n`)
      documentation.appendCodeblock(demo, 'html')
      // FIXME: setCommandParams要求 string[]
      const params = setCommandParams(demo as any)
      documentation.appendMarkdown(`\n<a href="command:intellisense.copyDemo?${params}">${copyIcon}</a>\n`)

      // FIXME: params要求string| string[]
      // const fixParams: any = [content, lib, isReact, prefix, dynamicLib || '', importWay || '']
      const fixParams: any = {
        data: content,
        lib,
        isReact,
        prefix,
        dynamicLib,
        importWay,
      }
      const completionItem: CompletionItem = createCompletionItem({ content: _content, snippet, preselect: true, detail: description, documentation, type: vscode.CompletionItemKind.TypeParameter, sortText: '0', params: fixParams, demo })
      return completionItem
    }),
  }]
}

function getComponentTagName(str: string) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').split('-').slice(-1)[0].toLowerCase()
}

export function hyphenate(s: string): string {
  return s.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')
}

export function toCamel(s: string) {
  return s.replace(/-(\w)/g, (_, v) => v.toUpperCase())
}

/**
 * Convert component name with prefix to standard component name
 * Handles both PascalCase (PButton) and kebab-case (p-button) formats
 * @param componentName - The full component name (e.g., "PButton", "p-button")
 * @param prefix - The prefix to strip (e.g., "P", "p")
 * @returns Standard component name (e.g., "Button")
 */
export function convertPrefixedComponentName(componentName: string, prefix: string): string | null {
  // Handle kebab-case: p-button -> Button
  componentName = componentName || ''
  if (componentName.includes('-')) {
    const kebabPrefix = `${prefix.toLowerCase()}-`
    if (componentName.startsWith(kebabPrefix)) {
      const compName = componentName.slice(kebabPrefix.length)
      return compName[0]?.toUpperCase() + toCamel(compName).slice(1)
    }
    return null
  }

  // Handle PascalCase: PButton -> Button
  const pascalPrefix = prefix[0]?.toUpperCase() + prefix.slice(1).toLowerCase()
  if (componentName.startsWith(pascalPrefix)) {
    const compName = componentName.slice(pascalPrefix.length)
    return compName[0]?.toUpperCase() + compName.slice(1)
  }

  return null
}

/**
 * Find matched component from UiCompletions using prefix-aware matching
 * @param componentName - The component name to search for
 * @param prefixes - Array of prefixes to try
 * @param UiCompletions - The UI completions object
 * @returns Matched component or null
 */
export function findPrefixedComponent(componentName: string, prefixes: string[], UiCompletions: any): any {
  // Try each prefix
  for (const prefix of prefixes) {
    const standardName = convertPrefixedComponentName(componentName, prefix)
    if (standardName) {
      if (UiCompletions[standardName])
        return UiCompletions[standardName]
      const prefixed = prefix[0]?.toUpperCase() + prefix.slice(1) + standardName
      if (UiCompletions[prefixed])
        return UiCompletions[prefixed]
    }
  }
  // direct exact match (e.g., componentName already matches a completion key)
  if (UiCompletions && UiCompletions[componentName])
    return UiCompletions[componentName]

  // Fallback: try suffix-based matching (case-insensitive) so tags injected
  // without prefix (e.g. "Pagination" or "pagination") can match prefixed
  // completion keys like "ElPagination".
  if (UiCompletions) {
    const want = componentName.toLowerCase()
    let bestKey: string | null = null
    for (const key of Object.keys(UiCompletions)) {
      const k = key.toLowerCase()
      if (!k.endsWith(want))
        continue
      // prefer longer key (more specific prefix), e.g. ElPagination over Pagination
      if (!bestKey || key.length > bestKey.length)
        bestKey = key
    }
    if (bestKey)
      return UiCompletions[bestKey]
  }

  return null
}

export async function getRequireProp(content: any, index = 0, isVue: boolean, parent: any = null): Promise<[string[], number]> {
  const requiredProps: string[] = []
  if (!content?.props)
    return [requiredProps, index]

  for (let key of Object.keys(content.props)) {
    const item = content.props[key]
    if (!item.required)
      continue
    let prefix = ''
    let prefixKey = ''
    if (item.related && item.related.length && parent) {
      for (const _item of item.related) {
        ;[prefix, prefixKey] = findValue(parent, _item)
        if (prefix)
          break
      }
    }
    let attr = ''
    const v = item.value
    if (key.startsWith(':')) {
      const tagName = getComponentTagName(content.name)
      const keyName = toCamel(key.split(':').slice(-1)[0])
      if (item.foreach) {
        if (requiredProps.some(p => p.includes('v-for=')))
          attr = `${key}="item.\${${++index}:${keyName}}"`
        else
          attr = `v-for="item in \${${++index}:${tagName}Options}" :key="item.\${${++index}:key}" ${key}="item.\${${++index}:${keyName}}"`
      }
      else {
        key = key.replace(':v-model', 'v-model')
        ++index
        if (!v) {
          if (isVue) {
            const openTranslate = getConfiguration('common-intellisense.translate')
            if (prefix && item[`$${prefixKey}`] && openTranslate) {
              const prefixValue = item[`$${prefixKey}`].replace(`$${prefixKey}`, prefix)
              // 替换 $()
              const fixedPrefixValue = await replaceAsync(prefixValue, /\$\(([^)]+)\)/g, async (_: string, m: string) => {
                // m 可能存在 xxx.a || xxx.b 的情况
                for (const splitItem of m.split(/\s*\|\|\s*/)) {
                  const [_prefix, _prefixKey] = findValue(parent, splitItem)
                  if (_prefix) {
                    let result = _prefix
                    if (isContainCn(_prefix)) {
                      try {
                        result = (await translate(_prefix, 'en'))
                      }
                      catch (errorMsg: any) {
                        logger.error(errorMsg.msg)
                      }
                    }
                    return result ? `${result[0].toLocaleLowerCase()}${camelize(result.slice(1))}` : result
                  }
                }
                return ''
              })
              if (fixedPrefixValue === `${prefix}.`)
                attr = `${key}="${prefix}.\${${index}:${tagName}${keyName[0].toUpperCase()}${keyName.slice(1)}}"`
              else
                attr = `${key}="\${${index}:${fixedPrefixValue}}"`
            }
            else {
              attr = `${key}="${prefix ? `${prefix}.` : ''}\${${index}:${tagName}${keyName[0].toUpperCase()}${keyName.slice(1)}}"`
            }
          }
          else {
            attr = `${key.slice(1)}={\${${index}:${tagName}${keyName[0].toUpperCase()}${keyName.slice(1)}}}`
          }
        }
        else {
          if (isVue)
            attr = `${key}="\${${index}:${tagName}${keyName[0].toUpperCase()}${keyName.slice(1)}}"`
          else
            attr = `${key.slice(1)}={\${${index}:${v}}}`
        }
      }
    }
    else if (item.type && item.type.toLowerCase().includes('boolean') && item.default?.toLowerCase() === 'false') {
      // 还要进一步看它的 type 如果 type === boolean 提供 true or false 如果是字符串，使用 / 或着 ｜ 分割，作为提示
      if (isVue)
        attr = key
      else
        attr = `${key}="true"`
    }
    else {
      const tempMap: any = {}
      const types = item.type.replace(/\s+/g, ' ').replace(/\{((?:[^{}]|\{[^{}]*\})*)\}|<((?:[^<>]|<[^<>]*>)*)>/g, (_: string) => {
        const key = hash(_)
        tempMap[key] = _.replace(/,/g, '\,')
        return key
      }).split(/[|/]/).filter((item: string) => {
        // 如果 item长度太长，可能有问题，所以也过滤掉
        return !!item && item.length < 40
      }).map((item: string) => item.replace(/['"]/g, '').trim()).map((item: string) => {
        Object.keys(tempMap).forEach((i) => {
          item = item.replace(i, tempMap[i])
        })
        return item
      })

      if (prefix && item[`$${prefixKey}`]) {
        attr = `${key}="${item[`$${prefixKey}`].replace(`$${prefixKey}`, prefix)}"`
      }
      else {
        if (item.default && types.includes(item.default)) {
          // 如果 item.default 并且在 type 中，将 types 的 default 值，放到
          const i = types.findIndex((i: string) => i === item.default)
          types.splice(i, 1)
          types.unshift(item.default)
        }
        const typeTips = types
          .map((item: string) => escapeRegExp(item).replace(/,/g, '\\,'))
          .join(',')

        if (v)
          attr = `${key}="${v}"`
        else
          attr = `${key}="\${${++index}|${prefix ? item.value + prefix : typeTips}|}"`
      }
    }
    requiredProps.push(attr)
  }

  for (const e of content.events || []) {
    if (!e.required)
      continue
    index++
    const [snippetEventNameOptions] = generateScriptNames(e.name)
    const snippetVue = `@${e.name}="\${${index}|${snippetEventNameOptions.join(',')}|}"`
    const snippetJsx = `${e.name}={\${${index}|${snippetEventNameOptions.join(',')}|}}`
    requiredProps.push(isVue ? snippetVue : snippetJsx)
  }

  return [requiredProps, index]
}

function findTargetMap(maps: any, suggestionTag: string | SuggestionItem) {
  let label = typeof suggestionTag === 'string' ? suggestionTag : suggestionTag.name
  label = toCamel(`-${label}`)
  for (const map of maps) {
    if (typeof map[0] === 'object') {
      if (toCamel(`-${map[0].name}`) === label)
        return map[0]
    }
    else if (toCamel(`-${map[0].name}`) === label) {
      return map
    }
  }
}

/**
 * generateSnippetNameOptions
 * return string name1,name2,name3
 */
function generateSnippetNameOptions(item: any, keyName: string, prefix: string) {
  if (keyName[0] === ':')
    keyName = keyName.slice(1)
  keyName = toCamel(keyName.replace(/:.*/, ''))
  const componentName = prefix ? item.name[prefix.length].toLowerCase() + item.name.slice(prefix.length + 1) : item.name
  const splitNames = componentName.split(/(?=[A-Z])/).map((i: string) => `${i.toLocaleLowerCase()}${keyName[0].toUpperCase()}${keyName.slice(1)}`)
  const splitNamesReverse = componentName.split(/(?=[A-Z])/).map((i: string) => `${keyName.toLocaleLowerCase()}${i}`)
  return [
    keyName,
    `${keyName}Value`,
    `is${keyName[0].toUpperCase()}${keyName.slice(1)}`,
    ...splitNames,
    ...splitNamesReverse,
    `${componentName}${keyName[0].toUpperCase()}${keyName.slice(1)}`,
    `${componentName}_${keyName}`,
  ].join(',')
}

export function hash(str: string) {
  let i
  let l
  let hval = 0x811C9DC5

  for (i = 0, l = str.length; i < l; i++) {
    hval ^= str.charCodeAt(i)
    hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24)
  }
  return `00000${(hval >>> 0).toString(36)}`.slice(-6)
}

export function isVue() {
  const currentFileUrl = getCurrentFileUrl()
  return !!currentFileUrl?.endsWith('.vue')
}

export function isVine() {
  const currentFileUrl = getCurrentFileUrl()
  return !!currentFileUrl?.endsWith('.vine.ts')
}

export function isVueOrVine() {
  return isVue() || isVine()
}

/**
 * escapeRegExp
 * @description 对字符串中的特殊字符进行转义以在正则表达式中使用它
 * @param str string
 * @returns string
 */
export function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function generateScriptNames(name: string): [string[], string] {
  if (name.startsWith('on'))
    name = name.slice(2)
  const _name = name.split(':').map((item: string) =>
    item[0] + item.slice(1),
  ).join('').replace(/-(\w)/g, (_: string, v: string) => v.toUpperCase())
  const options = [
    `on${_name[0].toUpperCase()}${_name.slice(1)}`,
    `handle${_name[0].toUpperCase()}${_name.slice(1)}`,
    `handle${_name[0].toUpperCase()}${_name.slice(1)}Event`,
    `${_name}Handler`,
  ]
  if (name === 'click') {
    options.push('onReset', 'onSubmit', 'onRefresh', 'onCancel', 'onSearch', 'onRequest', 'onSave', 'onClose', 'onOpen', 'onConfirm', 'onCancel', 'onOk', 'onError', 'onSuccess', 'onFailure', 'onComplete', 'onFinish', 'onStart', 'onStop', 'onPause', 'onResume', 'onPlay', 'onPause', 'onSeek', 'onSkip', 'onNext', 'onPrev', 'onFirst', 'onLast', 'onSelect', 'onUnselect', 'onSelectAll', 'onUnselectAll', 'onAdd', 'onRemove', 'onDelete', 'onEdit', 'onUpdate', 'onCreate', 'onDestroy', 'onShow', 'onHide', 'onVisible', 'onInvisible', 'onEnable', 'onDisable', 'onDisabled', 'onEnabled', 'onActive', 'onInactive', 'onFocus', 'onBlur', 'onFocusIn', 'onFocusOut', 'onHover', 'onEnter', 'onLeave', 'onScroll', 'onDrag', 'onDrop', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDragExit', 'onDrop', 'onDragDrop', 'onDragCancel', 'onDragMove', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDragExit', 'onDragDrop', 'onDragCancel', 'onDragMove', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDragExit', 'onDragDrop', 'onDragCancel', 'onDragMove', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDragExit', 'onDragDrop', 'onDragCancel', 'onDragMove', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDragExit', 'onDragDrop', 'onDragCancel', 'onDragMove', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDragExit', 'onDragDrop', 'onDragCancel', 'onDragMove', 'onDragStart')
  }
  else if (name === 'change') {
    options.push('onChange', 'onInput', 'onSelect', 'onCheck', 'onUncheck', 'onToggle', 'onSwitch', 'onSwitchChange', 'onSwitchToggle', 'onSwitchCheck', 'onSwitchUncheck', 'onSwitchSelect', 'onSwitchUnselect', 'onPasswordChange', 'onPasswordInput', 'onPasswordSelect', 'onPasswordCheck', 'onPasswordUncheck', 'onPasswordToggle', 'onPasswordSwitch', 'onPasswordSwitchChange', 'onPasswordSwitchToggle', 'onPasswordSwitchCheck', 'onPasswordSwitchUncheck', 'onPasswordSwitchSelect', 'onPasswordSwitchUnselect')
  }
  const snippetEventNameOptions = [
    ...new Set(
      options,
    ),
  ]
  return [snippetEventNameOptions, _name]
}

// 防止递归出现重复tag
async function getTemplateStr(map: any, content: any, index: number, isVue: boolean, isSeperatorByHyphen: boolean, parent?: any, tags = new Set<string>()): Promise<string> {
  const tag = isSeperatorByHyphen ? hyphenate(content.name) : content.name
  if (tags.has(tag))
    return `$${++index}`

  let [requiredProps, __index] = await getRequireProp(content, index, isVue, parent)
  tags.add(tag)

  const isFirst = tags.size > 1
  return `${isFirst ? '\n  ' : ''}<${tag}${requiredProps.length ? ' ' : ''}${requiredProps.join(' ')}$${++__index}>${await getSuggestionsTemplateStr(content, map, __index, isVue, isSeperatorByHyphen, parent, tags)}</${tag}>${isFirst ? '\n' : ''}`
}

async function getSuggestionsTemplateStr(content: any, map: any, index: number, isVue: boolean, isSeperatorByHyphen: boolean, parent: any, tags: Set<string>) {
  if (content.suggestions?.length) {
    const suggestionTag = content.suggestions[0]
    tags.add(suggestionTag)
    const suggestion = findTargetMap(map, suggestionTag)
    let [childRequiredProps, _index] = await getRequireProp(suggestion, index, isVue, parent)

    if (suggestion) {
      const children = await getTemplateStr(map, suggestion, ++_index, isVue, isSeperatorByHyphen, parent, tags)
      return `\n  <${suggestionTag}${childRequiredProps.length ? ' ' : ''}${childRequiredProps.join(' ')}$${_index}>${children}</${suggestionTag}>\n`
    }
    else {
      return `\n  <${suggestionTag}${childRequiredProps.length ? ' ' : ''}${childRequiredProps.join(' ')}$${++_index}>$${++_index}</${suggestionTag}>\n`
    }
  }
  return `$${++index}`
}

function findValue(parent: any, item: string) {
  let p = parent
  const name = item.split('.').slice(0, -1).join('.')
  const prop = item.split('.').slice(-1)[0]
  let prefix = ''
  const prefixKey = prop
  outerLoop: while (p) {
    if (p.tag === name) {
      const props = p.props
      if (props.length) {
        for (const p of props) {
          if (p.name === 'bind' && p.arg && p.arg.content === prop) {
            prefix = p.exp.content
            break outerLoop
          }
          else if (p.name === prop) {
            prefix = p.value.content
            break outerLoop
          }
        }
      }
    }
    p = p.parent
  }
  return [prefix, prefixKey]
}
