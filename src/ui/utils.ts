import type { CompletionItemOptions } from '@vscode-use/utils'
import type { DocumentEditIdentity } from './types'
import type { CompletionItem } from 'vscode'
import type { Component, Slots, SuggestionItem } from './ui-type'
import { camelize, compareVersion, isContainCn, reduceAsync, replaceAsync } from 'lazy-js-utils'
import { createCompletionItem, createHover, createMarkdownString, getConfiguration, getCurrentFileUrl, getLocale, setCommandParams } from '@vscode-use/utils'
import * as vscode from 'vscode'
import { translate } from '../translate'
import { resolveInstalledPackageVersion } from '../services/package-version'
import { logger } from '../ui/ui-find'

const TRUSTED_COMMANDS = {
  enabledCommands: [
    'intellisense.openDocument',
    'intellisense.openDocumentExternal',
    'intellisense.copyDemo',
  ],
}

function enableCommandTrust(documentation: vscode.MarkdownString) {
  documentation.isTrusted = TRUSTED_COMMANDS
  return documentation
}

export type CompletionFramework = 'vue' | 'vine' | 'react' | 'svelte'
export interface CompletionRenderContext {
  languageId: string
  /** Host controls ref/import semantics; syntax controls emitted markup. */
  hostFramework?: CompletionFramework
  syntax?: 'template' | 'jsx'
  /** @deprecated Prefer hostFramework/syntax. */
  framework: CompletionFramework
  uri: string
  version?: number
  /** Current template node, used by relation-aware prop snippets. */
  parent?: any
  vueBlock?: 'script' | 'scriptSetup'
  blockLang?: string
  packagePath?: string
  contextGeneration?: number
  contextRevision?: number
  sourceId?: string
  sourceSignature?: string
}
export type CompletionRenderInput = CompletionRenderContext | boolean | undefined

function getCompletionDocumentIdentity(context: CompletionRenderContext | undefined) {
  if (!context || typeof context.version !== 'number')
    return undefined
  return {
    uri: context.uri,
    version: context.version,
    vueBlock: context.vueBlock,
    blockLang: context.blockLang,
    packagePath: context.packagePath,
    contextGeneration: context.contextGeneration,
    contextRevision: context.contextRevision,
    sourceId: context.sourceId,
    sourceSignature: context.sourceSignature,
  }
}

function getSyntaxFramework(context: CompletionRenderContext | undefined, fallback: CompletionFramework): CompletionFramework {
  if (context?.syntax === 'jsx')
    return 'react'
  return context?.framework || fallback
}

export function renderComponentTag(componentName: string, framework: CompletionFramework, isSeparatedByHyphen: boolean) {
  const usesVueTemplateSyntax = framework === 'vue' || framework === 'vine'
  return usesVueTemplateSyntax && isSeparatedByHyphen ? hyphenate(componentName) : componentName
}

function getRenderedTagFromSnippet(snippet: string) {
  return snippet.trimStart().match(/^<([^\s/>$]+)/)?.[1]
}

export function renderSvelteEventPropName(event: { name: string, kind?: 'dom' | 'component' }) {
  if (event.kind !== 'dom')
    return event.name
  const normalized = event.name.toLowerCase()
  return normalized.startsWith('on') ? normalized : `on${normalized}`
}

function normalizeSuggestionName(suggestion: string | SuggestionItem | undefined): string | undefined {
  const name = typeof suggestion === 'string' ? suggestion : suggestion?.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

function normalizeRenderContext(input?: CompletionRenderInput): CompletionRenderContext {
  if (typeof input === 'object' && input)
    return input
  return {
    languageId: input ? 'vue' : 'typescriptreact',
    hostFramework: input ? 'vue' : 'react',
    syntax: input ? 'template' : 'jsx',
    framework: input ? 'vue' : 'react',
    uri: '',
    version: -1,
  }
}

function isVisibleForVersion(value: { version?: string } | undefined, installedVersion?: string, adapterMajor?: string) {
  if (!value)
    return true
  const version = typeof value.version === 'string' ? value.version.match(/\d+\.\d+\.\d+/)?.[0] : undefined
  if (!version)
    return true
  if (installedVersion)
    return compareVersion(version, installedVersion) !== 1
  if (adapterMajor)
    return Number(version.split('.')[0]) <= Number(adapterMajor)
  return true
}

export interface PropsOptions {
  uiName: string
  lib: string
  map: Component[]
  extensionContext?: vscode.ExtensionContext
  prefix?: string
  dynamicLib?: string
  resolveFrom?: string
  installedVersion?: string
  adapterMajor?: string
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
  completions: ((context?: CompletionRenderInput) => SubCompletionItem[])[]
  events: ((context?: CompletionRenderInput) => SubCompletionItem[])[]
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
  requiresImport?: boolean
  registerVueComponent?: boolean
  renderedTag?: string
  document?: DocumentEditIdentity
}

export type PropsConfig = Record<string, PropsConfigItem> & { icons?: Icons }

export function proxyCreateCompletionItem(options: CompletionItemOptions & {
  params?: string | string[]
}): SubCompletionItem {
  return createCompletionItem(options)
}

export function propsReducer(options: PropsOptions) {
  const { uiName, lib, map, prefix = '', dynamicLib, resolveFrom, installedVersion, adapterMajor } = options

  const result: PropsConfig = Object.create(null)
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
  let localVersion = installedVersion
  let effectiveAdapterMajor = adapterMajor
  let versionResolved = !!installedVersion

  return reduceAsync(map, async (result, item: Component) => {
    const completions: ((context?: CompletionRenderInput) => SubCompletionItem[])[] = []
    const events: ((context?: CompletionRenderInput) => SubCompletionItem[])[] = []
    const methods: SubCompletionItem[] = []
    const exposed: SubCompletionItem[] = []
    const slots: SubCompletionItem[] = []
    const isZh = getLocale().includes('zh')
    if (!versionResolved) {
      localVersion = await resolveInstalledPackageVersion(lib, resolveFrom)
      effectiveAdapterMajor ||= uiName.match(/\d+/)?.[0]
      versionResolved = true
    }

    if (!isVisibleForVersion(item, localVersion, effectiveAdapterMajor))
      return result

    const visibleProps = Object.fromEntries(Object.entries(item.props || {}).filter(([, value]) => isVisibleForVersion(value as any, localVersion, effectiveAdapterMajor)))
    const visibleEvents = (item.events || []).filter(value => isVisibleForVersion(value, localVersion, effectiveAdapterMajor))
    const visibleMethods = (item.methods || []).filter(value => isVisibleForVersion(value, localVersion, effectiveAdapterMajor))
    const visibleExposed = (item.exposed || []).filter(value => isVisibleForVersion(value, localVersion, effectiveAdapterMajor))
    const visibleSlots = (item.slots || []).filter(value => isVisibleForVersion(value, localVersion, effectiveAdapterMajor))

    const completionsDeferCallback = (input?: CompletionRenderInput) => {
      const renderContext = normalizeRenderContext(input)
      const syntaxFramework = getSyntaxFramework(renderContext, 'vue')
      const isVue = syntaxFramework === 'vue' || syntaxFramework === 'vine'
      const isHtmlLike = isVue || syntaxFramework === 'svelte'
      const data: SubCompletionItem[] = [
        'id',
        isHtmlLike ? 'class' : 'className',
        'ref',
      ].map(item => proxyCreateCompletionItem({ content: item, snippet: `${item}="\${1:}"`, type: 5, params: [] }))

      if (isHtmlLike)
        data.push(proxyCreateCompletionItem({ content: 'style', snippet: 'style="$1"', type: 5, params: [] }))
      else
        data.push(proxyCreateCompletionItem({ content: 'style', snippet: 'style={$1}', type: 5, params: [] }))

      // 过滤 props 中有 version 并且当前版本小于组件版本的属性
      Object.keys(visibleProps).forEach((key) => {
        const value = (visibleProps as any)[key]
        const normalizedDefault = value.default === undefined || value.default === '' ? undefined : String(value.default)
        const normalizedType = Array.isArray(value.type) ? value.type.join(' / ') : value.type
        let type = vscode.CompletionItemKind.Property
        if (typeof value.value !== 'string')
          type = vscode.CompletionItemKind.Enum

        const documentation = enableCommandTrust(new vscode.MarkdownString())
        const detail = []

        detail.push(`**${uiName} [${item.name}]**`)

        if (normalizedDefault !== undefined)
          detail.push(`- 💎 ${isZh ? '默认值' : 'default'}:    ***\`${normalizedDefault.replace(/[`\n]/g, '')}\`***`)

        if (value.version) {
          if (isZh)
            detail.push(`- 🚀 版本:    ***\`${value.version}\`***`)
          else
            detail.push(`- 🚀 version:    ***\`${value.version}\`***`)
        }

        if (value.platform) {
          detail.push(`- 🚀 平台:   ***\`${value.platform}\`***`)
        }

        if (value.description) {
          if (isZh)
            detail.push(`- 🔦 说明:    ***\`${value.description_zh || value.description}\`***`)
          else
            detail.push(`- 🔦 description:    ***\`${value.description}\`***`)
        }

        if (normalizedType)
          detail.push(`- 💡 ${isZh ? '类型' : 'type'}:    ***\`${normalizedType.replace(/`/g, '')}\`***`)

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
        if (isVue && renderContext.parent && value.related && value.related.length) {
          for (const _item of value.related) {
            ;[_prefix, _prefixKey] = findValue(renderContext.parent, _item)
            if (_prefix)
              break
          }
        }
        if (_prefix && value[`$${_prefixKey}`]) {
          const prefixValue = value[`$${_prefixKey}`].replace(`$${_prefixKey}`, _prefix)
          // 替换 $()
          const fixedPrefixValue = prefixValue.replace(/\$\(([^)]+)\)/g, (_: string, m: string) => {
            // m 可能存在 xxx.a || xxx.b 的情况
            for (const splitItem of m.split(/\s*\|\|\s*/)) {
              const [_prefix, _prefixKey] = findValue(renderContext.parent, splitItem)
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
            snippet = `${key}="${_prefix}.${fixedKey[0].toUpperCase()}${fixedKey.slice(1)}"`
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
        else if (normalizedType && normalizedType.toLowerCase().trim() === 'boolean' && normalizedDefault === 'false') {
          content = snippet = key
        }
        else if (normalizedType && normalizedType.toLowerCase().trim() === 'boolean' && normalizedDefault === 'true') {
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
          const bareKey = key.slice(1)
          if (!bareKey)
            return
          if (isVue) {
            const _key = key.replace('v-model', 'model')
            const keyHead = _key[1]
            if (!keyHead)
              return
            content = `${key.replace(':v-model', 'v-model')}="${getComponentTagName(item.name)}${keyHead.toUpperCase()}${toCamel(_key.slice(2))}"`
            snippet = `${key.replace(':v-model', 'v-model')}="\${1|${generateSnippetNameOptions(item, _key, prefix)}|}"$2`
          }
          else {
            content = `${bareKey}={${getComponentTagName(item.name)}${bareKey[0].toUpperCase()}${toCamel(bareKey.slice(1))}}`
            snippet = `${bareKey}={\${1|${generateSnippetNameOptions(item, key, prefix)}|}}$2`
          }
        }
        else {
          content = `${key}=""`

          if (normalizedType?.includes('/'))
            snippet = `${key}="\${1|${normalizedType.split('/').map((i: string) => i.replace(/['"`\s]/g, '').replace(/,/g, '\\,')).filter((i: string) => i.length).join(',')}|}"`
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
        if (normalizedDefault !== undefined) {
          detailsLines.push(isZh
            ? `***默认***: ${normalizedDefault.replace(/\n/g, '')}`
            : `***default***: ${normalizedDefault.replace(/\n/g, '')}`)
        }
        if (normalizedType) {
          detailsLines.push(isZh
            ? `***类型***: ${normalizedType.replace(/\n/g, '')}`
            : `***type***: ${normalizedType.replace(/\n/g, '')}`)
        }
        const details = detailsLines.join('\n-  ')
        const propDesc = isZh ? (value.description_zh || value.description) : value.description
        if (propDesc)
          content += `  ${propDesc}`
        if (normalizedDefault)
          content += `  ${isZh ? '默认' : 'default'}：${normalizedDefault.replace(/\n/g, '')}`
        data.push(createCompletionItem({
          content,
          details,
          snippet,
          type,
          documentation,
          preselect: true,
          sortText: '0',
          params: [uiName, key.replace(/^:/, '')],
          propType: Array.isArray(value.value) ? value.value.join(' / ') : normalizedType,
          command: {
            command: 'editor.action.triggerSuggest', // 这个命令会触发代码提示
            title: 'Trigger Suggest',
          },
        }))
      })
      return data
    }

    completions.push(completionsDeferCallback)

    const deferEventsCall = (input?: CompletionRenderInput) => {
      const renderContext = normalizeRenderContext(input)
      const syntaxFramework = getSyntaxFramework(renderContext, 'react')
      const isVue = syntaxFramework === 'vue' || syntaxFramework === 'vine'
      const isSvelte = syntaxFramework === 'svelte'
      const originEvent = [
        {
          name: isVue ? 'click' : isSvelte ? 'click' : 'onClick',
          ...(isSvelte ? { kind: 'dom' as const } : {}),
          description: 'click event',
          description_zh: '点击事件',
          params: [],
        },
      ]
      const localEvents = [...visibleEvents]

      originEvent.forEach((_event) => {
        if (!localEvents.find(event => event.name === _event.name))
          localEvents.push(_event)
      })

      // 过滤在某个版本才增加的新事件
      const filterEvents = localVersion
        ? localEvents.filter((event) => {
            const version = typeof event.version === 'string' ? event.version.match(/\d+\.\d+\.\d+/)?.[0] : undefined
            return !(version && compareVersion(version, localVersion!) === 1)
          })
        : localEvents

      return filterEvents.map((events: any) => {
        const detail: string[] = []
        const { name, description, params, description_zh, platform } = events

        detail.push(`**${uiName} [${item.name}]**`)

        if (description) {
          if (isZh)
            detail.push(`- 🔦 说明:    ***\`${description_zh || description}\`***`)
          else
            detail.push(`- 🔦 description:    ***\`${description}\`***`)
        }

        if (platform)
          detail.push(`- 🚀 平台:    ***\`${platform}\`***`)

        if (params)
          detail.push(`- 🔮 ${isZh ? '回调参数' : 'callback parameters'}:    ***\`${params}\`***`)

        let snippet
        let content
        if (isVue) {
          const [snippetEventNameOptions, _name] = generateScriptNames(name)
          snippet = `${name}="\${1|${snippetEventNameOptions.join(',')}|}"`
          content = `@${name}="on${_name}"`
        }
        else if (isSvelte) {
          const eventPropName = renderSvelteEventPropName(events)
          const handlerName = eventPropName.replace(/:(\w)/, (_: string, v: string) => v.toUpperCase())
          snippet = `${eventPropName}={\${1:${handlerName}}}`
          content = `${eventPropName}={${handlerName}}`
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
        const documentation = enableCommandTrust(new vscode.MarkdownString())
        documentation.appendMarkdown(detail.join('\n\n'))
        return proxyCreateCompletionItem({ content, snippet, details, documentation, type: vscode.CompletionItemKind.Event, sortText: '0', preselect: true, params: [uiName, name] })
      },
      )
    }
    events.push(deferEventsCall)

    if (visibleMethods.length) {
      methods.push(...visibleMethods.map((method) => {
        const documentation = enableCommandTrust(new vscode.MarkdownString())
        const detail: string[] = []
        const { name, description, params, description_zh } = method

        detail.push(`**${uiName} [${item.name}]**`)

        if (name)
          detail.push(`\n- 💨 ${isZh ? '方法' : 'method'} ${name}:`)

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

    if (visibleExposed.length) {
      exposed.push(...visibleExposed.map((expose) => {
        const documentation = enableCommandTrust(new vscode.MarkdownString())
        const details: string[] = []
        const { name, description, detail, description_zh } = expose

        details.push(`**${uiName} [${item.name}]**`)

        if (name)
          details.push(`\n- 💨 ${isZh ? '导出' : 'exposed'} ${name}:`)

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
        const exposedDetail = typeof expose.detail === 'string' ? expose.detail : ''
        return proxyCreateCompletionItem({ content: expose.name, snippet: exposedDetail.startsWith('()') ? `${expose.name}()` : expose.name, detail: exposedDetail, documentation, type: 1, sortText: 'a', preselect: true, params: uiName, hover })
      }))
    }

    if (visibleSlots.length) {
      visibleSlots.forEach((slot) => {
        const { name, description, description_zh } = slot
        const documentation = enableCommandTrust(new vscode.MarkdownString())
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
      const documentation = enableCommandTrust(createMarkdownString())
      const details: string[] = []
      let text = `**${uiName} [${item.name}]**`
      if (item.link) {
        text += `\`            \`[🔗 ${isZh ? '文档链接' : 'Documentation link'}](command:intellisense.openDocument?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D)\`   \`[🔗 ${isZh ? '外部链接' : 'External document links'}](command:intellisense.openDocumentExternal?%7B%22link%22%3A%22${encodeURIComponent(isZh ? (item?.link_zh || item.link) : item.link)}%22%7D) \`            \` [🌟 Star!](https://github.com/common-intellisense/common-intellisense) \`            \` [❤️ Sponsor!](https://github.com/Simon-He95/sponsor)`
      }
      details.push(text)

      if (Object.keys(visibleProps).length) {
        if (isZh)
          details.push('**参数:**')
        else
          details.push('**Props:**')

        const tableHeader = `| ${isZh ? '属性名' : 'Name'} | ${isZh ? '描述' : 'Description'} | ${isZh ? '类型' : 'Type'} | ${isZh ? '默认值' : 'Default'} |`
        const tableDivider = '| --- | --- | --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...Object.keys(visibleProps).map((name) => {
            const { default: defaultValue = '', type, description, description_zh } = (visibleProps as any)[name]
            let value = String(defaultValue).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
            value = String(defaultValue).length > 20 ? '...' : value
            const safeType = String(type).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|').replace(/\n/g, ' ')
            return `| \`${name}\` | \`${safeDescription}\` | \`${safeType || ''}\` | \`${value || ''}\` |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (visibleMethods.length) {
        if (isZh)
          details.push('**方法:**')
        else
          details.push('**Methods:**')

        const tableHeader = `| ${isZh ? '方法名' : 'Method Name'} | ${isZh ? '描述' : 'Description'} | ${isZh ? '参数' : 'Params'} |`
        const tableDivider = '| --- | --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...visibleMethods.map((m) => {
            const { name, params, description, description_zh } = m
            const safeName = String(name).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|')
            const safeParams = params ? String(params).replace(/\|/g, '\\|') : ''
            return `| ${safeName} | ${safeDescription} | ${safeParams} |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (visibleEvents.length) {
        if (isZh)
          details.push('**事件:**')
        else
          details.push('**Events:**')

        const tableHeader = `| ${isZh ? '事件名' : 'Event Name'} | ${isZh ? '描述' : 'Description'} | ${isZh ? '参数' : 'Params'} |`
        const tableDivider = '| --- | --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...visibleEvents.map((m) => {
            const { name, params, description, description_zh } = m
            const safeName = String(name).replace(/\|/g, '\\|')
            const safeDescription = String(isZh ? description_zh || description : description).replace(/\|/g, '\\|')
            const safeParams = params ? String(params).replace(/\|/g, '\\|') : '-'
            return `| ${safeName} | ${safeDescription} | ${safeParams} |`
          }),
        ].join('\n')

        details.push(tableContent)
      }

      if (visibleSlots.length) {
        if (isZh)
          details.push('**插槽:**')
        else
          details.push('**Slots:**')

        const tableHeader = `| ${isZh ? '插槽名' : 'Slot Name'} | ${isZh ? '描述' : 'Description'} |`
        const tableDivider = '| --- | --- |'

        const tableContent = [
          tableHeader,
          tableDivider,
          ...visibleSlots.map((m) => {
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
    const from = (item.dynamicLib || dynamicLib) ? (item.dynamicLib || dynamicLib)!.replace('${name}', hyphenate(name)) : lib
    result[item.name!] = { completions, events, methods, exposed, slots, suggestions: item.suggestions || [], tableDocument, rawSlots: visibleSlots, uiName, lib: from }
    return result
  }, result)
}
export type Directives = {
  name: string
  version?: string
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
  installedVersion?: string
  adapterMajor?: string
}

export interface ComponentsConfigItem {
  prefix: string
  directives?: Directives
  lib: string
  data: (parent?: any, context?: CompletionRenderContext) => Promise<CompletionItem>[]
  isReact?: boolean
  dynamicLib?: string
  importWay?: 'as default' | 'default' | 'specifier'
}

export type ComponentsConfig = ComponentsConfigItem[]
export function componentsReducer(options: ComponentOptions): ComponentsConfig {
  const { map: inputMap, isSeperatorByHyphen = true, prefix = '', lib, isReact = false, dynamicLib, importWay = 'specifier', directives, installedVersion, adapterMajor } = options
  const map = (inputMap as [Component | string, string, string?][]).map(([content, detail, demo]) => [
    typeof content === 'string' ? { name: content } : content,
    detail,
    demo,
  ] as [Component, string, string?]).filter(([component]) => isVisibleForVersion(component, installedVersion, adapterMajor))
  const visibleDirectives = directives?.filter(directive => isVisibleForVersion(directive, installedVersion, adapterMajor))
  // Suggestions are resolved while rendering every component completion. Build the
  // immutable lookup once so a manifest with N suggestions does not scan N rows
  // for every rendered item.
  const componentByName = createComponentSuggestionIndex(map, prefix)
  const isZh = getLocale().includes('zh')

  if (!isReact && prefix) {
    return [
      {
        prefix,
        directives: visibleDirectives,
        lib,
        data: (parent?: any, context?: CompletionRenderContext) => (map as [Component | string, string, string?][]).map(async ([content, detail, demo]) => {
          const framework = getSyntaxFramework(context, 'vue')
          let snippet = ''
          let _content = ''
          let description = ''
          let itemDynamicLib = dynamicLib
          let itemImportWay = importWay
          if (typeof content === 'object') {
            itemDynamicLib = content.dynamicLib || dynamicLib
            itemImportWay = content.importWay || importWay

            const tag = renderComponentTag(content.name, framework, isSeperatorByHyphen)
            snippet = await getTemplateStr(componentByName, content, 0, framework, isSeperatorByHyphen, parent)
            _content = `${tag}  ${content.tag || detail}`
            description = isZh && content.description_zh ? content.description_zh : content.description || ''
          }
          else {
            snippet = `<${content}$1>$2</${content}>`
            _content = `${content}  ${detail}`
          }
          if (!demo)
            demo = snippet
          const documentation = enableCommandTrust(new vscode.MarkdownString())

          documentation.appendMarkdown(`**🍀 ${lib} ${detail}**\n`)
          if (typeof content === 'object' && content.suggestions?.length) {
            documentation.appendMarkdown(`\n**👗 ${isZh ? '常用搭配' : 'Common collocation'}** \n`)
            // FIXME: suggestions的Item有对象形式的vant4里面,里面的文案要怎么展示
            documentation.appendMarkdown(`${content.suggestions.map(normalizeSuggestionName).filter((name): name is string => !!name).map(name => `- ${name}`).join('\n')}\n`)
          }
          documentation.appendMarkdown(`**🌰 ${isZh ? '例子' : 'example'}**\n`)
          documentation.appendCodeblock(demo, 'html')
          // FIXME: 要求输入数组，但是demo类型是字符串，但是都通过JSON.stringify处理了，所以这里转成[demo]?
          const params = setCommandParams(demo as any)
          documentation.appendMarkdown(`\n[Copy](command:intellisense.copyDemo?${params})\n`)

          // FIXME: params要求string| string[]
          // const fixParams: FixParams = [content as Component, lib, isReact, prefix, dynamicLib || '', importWay || '']
          const fixParams: any = {
            data: content,
            lib,
            isReact,
            requiresImport: context?.syntax === 'jsx' || context?.hostFramework === 'svelte' || isReact,
            prefix,
            dynamicLib: itemDynamicLib || '',
            importWay: itemImportWay || 'specifier',
            registerVueComponent: context?.hostFramework === 'vue' && context.syntax === 'template',
            renderedTag: getRenderedTagFromSnippet(snippet),
            document: getCompletionDocumentIdentity(context),
          }
          return createCompletionItem({ content: _content, preselect: true, snippet, detail: description, documentation, type: vscode.CompletionItemKind.TypeParameter, sortText: '0', params: fixParams, demo })
        }),
      },
      {
        prefix: '',
        directives: visibleDirectives,
        lib,
        data: (parent?: any, context?: CompletionRenderContext) => (map as [Component | string, string, string?][]).map(async ([content, detail, demo]) => {
          const framework = getSyntaxFramework(context, 'vue')
          let snippet = ''
          let _content = ''
          let description = ''
          let itemDynamicLib = dynamicLib
          let itemImportWay = importWay
          if (typeof content === 'object') {
            itemDynamicLib = content.dynamicLib || dynamicLib
            itemImportWay = content.importWay || importWay
            const importName = content.name.slice(prefix.length)
            const renderedName = framework === 'react' ? importName : content.name
            snippet = await getTemplateStr(componentByName, { ...content, name: renderedName }, 0, framework, isSeperatorByHyphen, parent)
            _content = `${renderComponentTag(renderedName, framework, isSeperatorByHyphen)}  ${content.tag || detail}`
            description = isZh && content.description_zh ? content.description_zh : content.description || ''
          }
          else {
            snippet = `<${content}$1>$2</${content}>`
            _content = `${content}  ${detail}`
          }
          if (!demo)
            demo = snippet
          const documentation = enableCommandTrust(new vscode.MarkdownString())
          documentation.appendMarkdown(`**🍀 ${lib} ${detail}**\n`)
          if (typeof content === 'object' && content.suggestions?.length) {
            documentation.appendMarkdown(`\n**👗 ${isZh ? '常用搭配' : 'Common collocation'}** \n`)
            documentation.appendMarkdown(`${content.suggestions.map(normalizeSuggestionName).filter((name): name is string => !!name).map(name => `- ${name}`).join('\n')}\n`)
          }
          documentation.appendMarkdown(`**🌰 ${isZh ? '例子' : 'example'}**\n`)
          documentation.appendCodeblock(demo, 'html')
          // FIXME: 同上
          const params = setCommandParams(demo as any)
          documentation.appendMarkdown(`\n[Copy](command:intellisense.copyDemo?${params})\n`)

          // FIXME: params要求string| string[]
          const fixParams: any = {
            data: { ...(content as any), name: (content as any).name?.slice(prefix.length) },
            lib,
            isReact: true,
            requiresImport: true,
            prefix,
            dynamicLib: itemDynamicLib,
            importWay: itemImportWay,
            registerVueComponent: context?.hostFramework === 'vue' && context.syntax === 'template',
            renderedTag: getRenderedTagFromSnippet(snippet),
            document: getCompletionDocumentIdentity(context),
          }
          // const fixParams: any = [{ ...(content as any), name: (content as any).name?.slice(prefix.length) }, lib, true, prefix, dynamicLib, importWay]
          return createCompletionItem({ content: _content, detail: description, snippet, documentation, type: vscode.CompletionItemKind.TypeParameter, sortText: '0', params: fixParams, demo })
        }),
      },
    ]
  }
  return [{
    prefix,
    directives: visibleDirectives,
    lib,
    data: (parent?: any, context?: CompletionRenderContext) => (map as [Component | string, string, string?][]).map(async ([content, detail, demo]) => {
      const framework = getSyntaxFramework(context, 'react')
      let snippet = ''
      let _content = ''
      let description = ''
      let itemDynamicLib = dynamicLib
      let itemImportWay = importWay
      if (typeof content === 'object') {
        itemDynamicLib = content.dynamicLib || dynamicLib
        itemImportWay = content.importWay || importWay
        snippet = await getTemplateStr(componentByName, content, 0, framework, isSeperatorByHyphen, parent)
        const tag = renderComponentTag(content.name, framework, isSeperatorByHyphen)
        _content = `${tag}  ${content.tag || detail}`
        description = isZh && content.description_zh ? content.description_zh : content.description || ''
      }
      else {
        snippet = `<${content}$1>$2</${content}>`
        _content = `${content}  ${detail}`
      }
      if (!demo)
        demo = snippet

      const documentation = enableCommandTrust(new vscode.MarkdownString())
      documentation.appendMarkdown(`**🍀 ${lib} ${detail}**\n`)
      if (typeof content === 'object' && content.suggestions?.length) {
        documentation.appendMarkdown(`\n**👗 ${isZh ? '常用搭配' : 'Common collocation'}** \n`)
        documentation.appendMarkdown(`${content.suggestions.map(normalizeSuggestionName).filter((name): name is string => !!name).map(name => `- ${name}`).join('\n')}\n`)
      }
      documentation.appendMarkdown(`**🌰 ${isZh ? '例子' : 'example'}**\n`)
      documentation.appendCodeblock(demo, 'html')
      // FIXME: setCommandParams要求 string[]
      const params = setCommandParams(demo as any)
      documentation.appendMarkdown(`\n[Copy](command:intellisense.copyDemo?${params})\n`)

      // FIXME: params要求string| string[]
      // const fixParams: any = [content, lib, isReact, prefix, dynamicLib || '', importWay || '']
      const fixParams: any = {
        data: content,
        lib,
        isReact,
        requiresImport: context?.syntax === 'jsx' || context?.hostFramework === 'svelte' || isReact,
        prefix,
        dynamicLib: itemDynamicLib,
        importWay: itemImportWay,
        registerVueComponent: context?.hostFramework === 'vue' && context.syntax === 'template',
        document: getCompletionDocumentIdentity(context),
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

export async function getRequireProp(content: any, index = 0, framework: CompletionFramework | boolean, parent: any = null): Promise<[string[], number]> {
  const isVue = framework === true || framework === 'vue' || framework === 'vine'
  const isHtmlLike = isVue || framework === 'svelte'
  const requiredProps: string[] = []
  if (!content?.props)
    return [requiredProps, index]

  for (let key of Object.keys(content.props)) {
    const item = content.props[key]
    if (!item?.required)
      continue
    const typeText = typeof item.type === 'string' ? item.type : ''
    const defaultText = item.default == null ? '' : String(item.default)
    const valueText = item.value == null ? '' : String(item.value)
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
    const v = valueText
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
    else if (typeText.toLowerCase().includes('boolean')) {
      if (isHtmlLike)
        attr = key
      else
        attr = `${key}={true}`
    }
    else {
      const tempMap: any = {}
      const types = typeText.replace(/\s+/g, ' ').replace(/\{((?:[^{}]|\{[^{}]*\})*)\}|<((?:[^<>]|<[^<>]*>)*)>/g, (_: string) => {
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
        if (defaultText && types.includes(defaultText)) {
          const i = types.findIndex((i: string) => i === defaultText)
          types.splice(i, 1)
          types.unshift(defaultText)
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
    const svelteName = renderSvelteEventPropName(e)
    const snippetSvelte = `${svelteName}={\${${index}|${snippetEventNameOptions.join(',')}|}}`
    requiredProps.push(isVue ? snippetVue : framework === 'svelte' ? snippetSvelte : snippetJsx)
  }

  return [requiredProps, index]
}

function normalizeSuggestionLookupName(name: string) {
  return toCamel(`-${name}`)
}

export function createComponentSuggestionIndex(maps: [Component, string, string?][], prefix = '') {
  const index = new Map<string, Component>()
  for (const [component] of maps) {
    const name = component?.name
    if (typeof name !== 'string' || !name)
      continue
    index.set(normalizeSuggestionLookupName(name), component)
    index.set(normalizeSuggestionLookupName(hyphenate(name)), component)
    if (prefix && name.startsWith(prefix) && name.length > prefix.length) {
      const unprefixed = name.slice(prefix.length)
      index.set(normalizeSuggestionLookupName(unprefixed), component)
      index.set(normalizeSuggestionLookupName(hyphenate(unprefixed)), component)
    }
  }
  return index
}

export function findTargetMap(maps: any, suggestionTag: string) {
  const label = normalizeSuggestionLookupName(suggestionTag)
  for (const map of maps) {
    const component = Array.isArray(map) ? map[0] : undefined
    if (component && typeof component === 'object' && normalizeSuggestionLookupName(component.name) === label)
      return component
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
  if (!keyName)
    return ''
  const itemName = typeof item?.name === 'string' ? item.name : ''
  const unprefixed = prefix && itemName.startsWith(prefix) && itemName.length > prefix.length
    ? itemName.slice(prefix.length)
    : itemName
  const componentName = unprefixed ? `${unprefixed[0].toLowerCase()}${unprefixed.slice(1)}` : itemName
  const splitNames = componentName.split(/(?=[A-Z])/).filter(Boolean).map((i: string) => `${i.toLocaleLowerCase()}${keyName[0].toUpperCase()}${keyName.slice(1)}`)
  const splitNamesReverse = componentName.split(/(?=[A-Z])/).filter(Boolean).map((i: string) => `${keyName.toLocaleLowerCase()}${i}`)
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
async function getTemplateStr(componentByName: Map<string, Component>, content: any, index: number, framework: CompletionFramework, isSeperatorByHyphen: boolean, parent?: any, tags = new Set<string>()): Promise<string> {
  const tag = renderComponentTag(content.name, framework, isSeperatorByHyphen)
  if (tags.has(tag))
    return `$${++index}`

  let [requiredProps, __index] = await getRequireProp(content, index, framework, parent)
  tags.add(tag)

  const isFirst = tags.size > 1
  return `${isFirst ? '\n  ' : ''}<${tag}${requiredProps.length ? ' ' : ''}${requiredProps.join(' ')}$${++__index}>${await getSuggestionsTemplateStr(content, componentByName, __index, framework, isSeperatorByHyphen, parent, tags)}</${tag}>${isFirst ? '\n' : ''}`
}

async function getSuggestionsTemplateStr(content: any, componentByName: Map<string, Component>, index: number, framework: CompletionFramework, isSeperatorByHyphen: boolean, parent: any, tags: Set<string>) {
  if (content.suggestions?.length) {
    const suggestionName = normalizeSuggestionName(content.suggestions[0])
    if (!suggestionName)
      return `$${++index}`
    const suggestion = componentByName.get(normalizeSuggestionLookupName(suggestionName))
    const suggestionTag = renderComponentTag(suggestionName, framework, isSeperatorByHyphen)

    if (suggestion) {
      if (tags.has(suggestionTag))
        return `$${index + 1}`
      return getTemplateStr(componentByName, suggestion, index, framework, isSeperatorByHyphen, parent, tags)
    }
    tags.add(suggestionTag)
    return `\n  <${suggestionTag}$${index + 1}>$${index + 2}</${suggestionTag}>\n`
  }
  return `$${++index}`
}

function findValue(parent: any, item: unknown) {
  if (typeof item !== 'string' || !item.includes('.'))
    return ['', '']
  let p = parent
  const name = item.split('.').slice(0, -1).join('.')
  const prop = item.split('.').slice(-1)[0]
  let prefix = ''
  const prefixKey = prop
  outerLoop: while (p) {
    if (p.tag === name) {
      const props = Array.isArray(p.props) ? p.props : []
      if (props.length) {
        for (const p of props) {
          if (p?.name === 'bind' && p.arg?.content === prop && typeof p.exp?.content === 'string') {
            prefix = p.exp.content
            break outerLoop
          }
          else if (p?.name === prop && typeof p.value?.content === 'string') {
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
