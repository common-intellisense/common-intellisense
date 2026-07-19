type PlainRecord = Record<string, unknown>

const maxComponentsPerLibrary = 500
const maxComponentMembers = 250
const maxAggregateComponents = 1_000
const maxAggregateMembers = 20_000
const maxDomainStringLength = 10_000
const maxDemoStringLength = 64 * 1024
const unsafeObjectKeys = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'then',
])
const reservedComponentNames = new Set([...unsafeObjectKeys, 'icons'])
const componentNameRE
  = /^(?:[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\.[A-Z][A-Za-z0-9]*)*$/
const staticArgumentRE = /^[A-Z_][\w-]*$/i
const eventNameRE
  = /^(?:on[A-Z][A-Za-z0-9]*|[A-Za-z_][\w-]*)(?::[A-Za-z_][\w-]*)?$/
const methodNameRE = /^[A-Z_$][\w$]*(?:\(\))?$/i

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(path: string): never {
  throw new TypeError(`Invalid adapter manifest field: ${path}`)
}

interface NormalizationBudget {
  members: number
  path: string
}

function consumeMembers(budget: NormalizationBudget, count: number) {
  budget.members += count
  if (budget.members > maxAggregateMembers)
    invalid(`${budget.path}.members`)
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxDomainStringLength || value.includes('\0'))
    invalid(path)
  return value
}

function requireSourceToken(value: unknown, path: string, pattern: RegExp) {
  const token = requireNonEmptyString(value, path)
  if (token !== token.trim() || /[\r\n]/.test(token) || !pattern.test(token))
    invalid(path)
  return token
}

function requireSafeComponentName(value: unknown, path: string) {
  const name = requireSourceToken(value, path, componentNameRE)
  if (reservedComponentNames.has(name))
    invalid(path)
  return name
}

function requireStaticArgument(value: unknown, path: string) {
  return requireSourceToken(value, path, staticArgumentRE)
}

function requireSafeSnippetString(value: unknown, path: string) {
  if (typeof value !== 'string' || value.length > maxDomainStringLength || /[\0\r\n]/.test(value))
    invalid(path)
  return value
}

function validateOptionalString(
  record: PlainRecord,
  key: string,
  path: string,
) {
  if (
    record[key] !== undefined
    && (typeof record[key] !== 'string'
      || record[key].length > maxDomainStringLength)
  ) {
    invalid(`${path}.${key}`)
  }
}

function validateOptionalBoolean(
  record: PlainRecord,
  key: string,
  path: string,
) {
  if (record[key] !== undefined && typeof record[key] !== 'boolean')
    invalid(`${path}.${key}`)
}

function copyKnownFields(
  record: PlainRecord,
  keys: readonly string[],
  path: string,
  overrides: PlainRecord = {},
) {
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      invalid(`${path}.${key}`)
  }
  const clone: PlainRecord = Object.create(null)
  for (const key of keys) {
    if (record[key] !== undefined)
      clone[key] = record[key]
  }
  for (const [key, value] of Object.entries(overrides)) clone[key] = value
  return clone
}

function validateOptionalSnippetValue(
  record: PlainRecord,
  key: string,
  path: string,
) {
  const value = record[key]
  if (
    value === undefined
    || value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return
  }
  requireSafeSnippetString(value, `${path}.${key}`)
}

function normalizeParams(
  value: unknown,
  path: string,
  budget: NormalizationBudget,
) {
  if (value === undefined)
    return undefined
  if (typeof value === 'string')
    return requireNonEmptyString(value, path)
  if (!Array.isArray(value) || value.length > maxComponentMembers)
    invalid(path)
  consumeMembers(budget, value.length)
  return value.map((entry, index) => {
    if (typeof entry === 'string')
      return requireNonEmptyString(entry, `${path}[${index}]`)
    if (!isPlainRecord(entry))
      invalid(`${path}[${index}]`)
    const entryPath = `${path}[${index}]`
    for (const key of ['name', 'description', 'description_zh', 'type', 'default'])
      validateOptionalString(entry, key, entryPath)
    return copyKnownFields(entry, ['name', 'description', 'description_zh', 'type', 'default'], entryPath)
  })
}

function normalizeTypeDetail(
  value: unknown,
  path: string,
  budget: NormalizationBudget,
) {
  if (value === undefined)
    return undefined
  if (!isPlainRecord(value))
    invalid(path)
  const keys = Object.keys(value)
  if (keys.length > maxComponentMembers)
    invalid(path)
  consumeMembers(budget, keys.length)
  const normalized: PlainRecord = Object.create(null)
  for (const [key, detail] of Object.entries(value)) {
    if (unsafeObjectKeys.has(key))
      invalid(`${path}.${key}`)
    if (typeof detail === 'string') {
      normalized[key] = requireNonEmptyString(detail, `${path}.${key}`)
      continue
    }
    if (!Array.isArray(detail) || detail.length > maxComponentMembers)
      invalid(`${path}.${key}`)
    consumeMembers(budget, detail.length)
    normalized[key] = detail.map((entry, index) => {
      if (!isPlainRecord(entry))
        invalid(`${path}.${key}[${index}]`)
      const entryPath = `${path}.${key}[${index}]`
      for (const field of ['name', 'description', 'description_zh', 'type', 'params', 'value', 'default'])
        validateOptionalString(entry, field, entryPath)
      validateOptionalBoolean(entry, 'optional', entryPath)
      return copyKnownFields(entry, ['name', 'description', 'description_zh', 'type', 'params', 'value', 'default', 'optional'], entryPath)
    })
  }
  return normalized
}

function normalizeSuggestions(
  value: unknown,
  path: string,
  budget: NormalizationBudget,
) {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.length > maxComponentMembers)
    invalid(path)
  consumeMembers(budget, value.length)
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`
    if (typeof entry === 'string')
      return requireSafeComponentName(entry, entryPath)
    if (!isPlainRecord(entry))
      invalid(entryPath)
    const name = requireSafeComponentName(entry.name, `${entryPath}.name`)
    validateOptionalString(entry, 'description', entryPath)
    validateOptionalString(entry, 'description_zh', entryPath)
    return copyKnownFields(
      entry,
      ['name', 'description', 'description_zh'],
      entryPath,
      { name },
    )
  })
}

type NamedEntryKind = 'event' | 'method' | 'slot' | 'exposed'

function normalizeNamedArray(
  value: unknown,
  path: string,
  budget: NormalizationBudget,
  kind: NamedEntryKind,
) {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.length > maxComponentMembers)
    invalid(path)
  consumeMembers(budget, value.length)
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`
    if (!isPlainRecord(entry))
      invalid(entryPath)
    const name = requireSourceToken(
      entry.name,
      `${entryPath}.name`,
      kind === 'event'
        ? eventNameRE
        : kind === 'method' || kind === 'exposed'
          ? methodNameRE
          : staticArgumentRE,
    )
    for (const key of [
      'description',
      'description_zh',
      'version',
      'detail',
      'platform',
    ])
      validateOptionalString(entry, key, entryPath)
    if (entry.value !== undefined)
      requireSafeSnippetString(entry.value, `${entryPath}.value`)
    if (
      kind === 'event'
      && entry.kind !== undefined
      && entry.kind !== 'dom'
      && entry.kind !== 'component'
    ) {
      invalid(`${entryPath}.kind`)
    }
    if (kind === 'event')
      validateOptionalBoolean(entry, 'required', entryPath)
    const params = normalizeParams(entry.params, `${entryPath}.params`, budget)
    return {
      name,
      description: entry.description,
      description_zh: entry.description_zh,
      version: entry.version,
      detail: entry.detail,
      platform: entry.platform,
      value: entry.value,
      params,
      ...(kind === 'event'
        ? { kind: entry.kind, required: entry.required }
        : {}),
    }
  })
}

function normalizeProp(
  prop: PlainRecord,
  path: string,
  budget: NormalizationBudget,
) {
  for (const key of [
    'type',
    'version',
    'description',
    'description_zh',
    'platform',
  ])
    validateOptionalString(prop, key, path)
  for (const key of ['required', 'foreach'])
    validateOptionalBoolean(prop, key, path)
  validateOptionalSnippetValue(prop, 'default', path)
  if (
    prop.related !== undefined
    && (!Array.isArray(prop.related)
      || prop.related.length > maxComponentMembers
      || prop.related.some(
        item =>
          typeof item !== 'string'
          || !item.length
          || item !== item.trim()
          || item.length > maxDomainStringLength
          || !/^[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)+$/i.test(item),
      ))
  ) {
    invalid(`${path}.related`)
  }
  if (Array.isArray(prop.related))
    consumeMembers(budget, prop.related.length)
  if (prop.value !== undefined) {
    if (typeof prop.value === 'string') {
      requireSafeSnippetString(prop.value, `${path}.value`)
    }
    else if (
      !Array.isArray(prop.value)
      || prop.value.length > maxComponentMembers
      || prop.value.some(
        item =>
          typeof item !== 'string'
          || !item.length
          || /[\0\r\n]/.test(item)
          || item.length > maxDomainStringLength,
      )
    ) {
      invalid(`${path}.value`)
    }
    else {
      consumeMembers(budget, prop.value.length)
    }
  }
  for (const key of Object.keys(prop)) {
    if (key.startsWith('$'))
      invalid(`${path}.${key}`)
  }
  const typeDetail = normalizeTypeDetail(
    prop.typeDetail,
    `${path}.typeDetail`,
    budget,
  )
  return copyKnownFields(
    prop,
    [
      'type',
      'version',
      'description',
      'description_zh',
      'platform',
      'required',
      'foreach',
      'related',
      'value',
      'default',
      'typeDetail',
    ],
    path,
    { typeDetail },
  )
}

function normalizeComponent(
  value: unknown,
  path: string,
  budget: NormalizationBudget,
) {
  if (!isPlainRecord(value))
    invalid(path)
  const name = requireSafeComponentName(value.name, `${path}.name`)
  for (const key of [
    'description',
    'description_zh',
    'tag',
    'link',
    'link_zh',
    'dynamicLib',
    'version',
    'from',
  ])
    validateOptionalString(value, key, path)
  if (
    value.importWay !== undefined
    && !['as default', 'default', 'specifier'].includes(String(value.importWay))
  ) {
    invalid(`${path}.importWay`)
  }
  if (
    value.props !== undefined
    && (!isPlainRecord(value.props)
      || Object.keys(value.props).length > maxComponentMembers)
  ) {
    invalid(`${path}.props`)
  }
  const propEntries = Object.entries(value.props || {})
  consumeMembers(budget, propEntries.length)
  const props: PlainRecord = Object.create(null)
  for (const [propName, prop] of propEntries) {
    const bareName = propName.startsWith(':') ? propName.slice(1) : propName
    requireStaticArgument(bareName, `${path}.props.${propName || '<empty>'}`)
    if (!isPlainRecord(prop))
      invalid(`${path}.props.${propName}`)
    props[propName] = normalizeProp(prop, `${path}.props.${propName}`, budget)
  }
  return copyKnownFields(
    value,
    [
      'name',
      'description',
      'description_zh',
      'tag',
      'link',
      'link_zh',
      'dynamicLib',
      'version',
      'importWay',
      'from',
      'props',
      'events',
      'methods',
      'slots',
      'exposed',
      'suggestions',
      'typeDetail',
    ],
    path,
    {
      name,
      props,
      events: normalizeNamedArray(
        value.events,
        `${path}.events`,
        budget,
        'event',
      ),
      methods: normalizeNamedArray(
        value.methods,
        `${path}.methods`,
        budget,
        'method',
      ),
      slots: normalizeNamedArray(value.slots, `${path}.slots`, budget, 'slot'),
      exposed: normalizeNamedArray(
        value.exposed,
        `${path}.exposed`,
        budget,
        'exposed',
      ),
      suggestions: normalizeSuggestions(
        value.suggestions,
        `${path}.suggestions`,
        budget,
      ),
      typeDetail: normalizeTypeDetail(
        value.typeDetail,
        `${path}.typeDetail`,
        budget,
      ),
    },
  )
}

function isSafeDirectiveValue(value: unknown) {
  return (
    value === null || ['string', 'number', 'boolean'].includes(typeof value)
  )
}

function normalizeDirectives(
  value: unknown,
  path: string,
  budget: NormalizationBudget,
) {
  if (value === undefined)
    return undefined
  if (!Array.isArray(value) || value.length > maxComponentMembers)
    invalid(path)
  consumeMembers(budget, value.length)
  return value.map((directive, index) => {
    const directivePath = `${path}[${index}]`
    if (!isPlainRecord(directive))
      invalid(directivePath)
    const name = requireStaticArgument(directive.name, `${directivePath}.name`)
    for (const key of [
      'description',
      'description_zh',
      'documentation',
      'documentationType',
      'link',
      'link_zh',
      'version',
    ])
      validateOptionalString(directive, key, directivePath)
    if (
      directive.params !== undefined
      && (!Array.isArray(directive.params)
        || directive.params.length > maxComponentMembers)
    ) {
      invalid(`${directivePath}.params`)
    }
    const rawParams = (directive.params || []) as unknown[]
    consumeMembers(budget, rawParams.length)
    const params = rawParams.map((param, paramIndex) => {
      const paramPath = `${directivePath}.params[${paramIndex}]`
      if (!isPlainRecord(param))
        invalid(paramPath)
      const name = requireSourceToken(param.name, `${paramPath}.name`, /^[A-Z_]\w*$/i)
      requireNonEmptyString(param.type, `${paramPath}.type`)
      for (const key of ['description', 'description_zh'])
        validateOptionalString(param, key, paramPath)
      for (const key of ['default', 'value']) {
        if (param[key] !== undefined && !isSafeDirectiveValue(param[key]))
          invalid(`${paramPath}.${key}`)
        if (typeof param[key] === 'string')
          requireSafeSnippetString(param[key], `${paramPath}.${key}`)
      }
      return copyKnownFields(param, ['name', 'type', 'description', 'description_zh', 'default', 'value'], paramPath, { name })
    })
    return copyKnownFields(directive, ['name', 'description', 'description_zh', 'documentation', 'documentationType', 'link', 'link_zh', 'version', 'params'], directivePath, { name, params })
  })
}

function normalizeComponentsExport(
  value: PlainRecord,
  path: string,
  budget: NormalizationBudget,
) {
  requireNonEmptyString(value.lib, `${path}.lib`)
  for (const key of ['prefix', 'dynamicLib', 'installedVersion', 'adapterMajor'])
    validateOptionalString(value, key, path)
  for (const key of ['isReact', 'isSeperatorByHyphen'])
    validateOptionalBoolean(value, key, path)
  if (
    value.importWay !== undefined
    && !['as default', 'default', 'specifier'].includes(String(value.importWay))
  ) {
    invalid(`${path}.importWay`)
  }
  if (!Array.isArray(value.map) || value.map.length > maxComponentsPerLibrary)
    invalid(`${path}.map`)
  const map = value.map.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 3)
      invalid(`${path}.map[${index}]`)
    const component = entry[0]
    const normalizedComponent
      = typeof component === 'string'
        ? requireSafeComponentName(component, `${path}.map[${index}][0]`)
        : normalizeComponent(component, `${path}.map[${index}][0]`, budget)
    if (
      entry[1] !== undefined
      && (typeof entry[1] !== 'string' || entry[1].length > maxDomainStringLength)
    ) {
      invalid(`${path}.map[${index}][1]`)
    }
    if (
      entry[2] !== undefined
      && (typeof entry[2] !== 'string' || entry[2].length > maxDemoStringLength)
    ) {
      invalid(`${path}.map[${index}][2]`)
    }
    return [normalizedComponent, ...entry.slice(1)]
  })
  return copyKnownFields(value, ['lib', 'prefix', 'dynamicLib', 'importWay', 'isReact', 'isSeperatorByHyphen', 'installedVersion', 'adapterMajor', 'map', 'directives'], path, {
    map,
    directives: normalizeDirectives(value.directives, `${path}.directives`, budget),
  })
}

function normalizePropsExport(
  value: PlainRecord,
  path: string,
  budget: NormalizationBudget,
) {
  requireNonEmptyString(value.uiName, `${path}.uiName`)
  requireNonEmptyString(value.lib, `${path}.lib`)
  for (const key of [
    'prefix',
    'dynamicLib',
    'resolveFrom',
    'installedVersion',
    'adapterMajor',
  ])
    validateOptionalString(value, key, path)
  if (!Array.isArray(value.map) || value.map.length > maxComponentsPerLibrary)
    invalid(`${path}.map`)
  return copyKnownFields(value, ['uiName', 'lib', 'prefix', 'dynamicLib', 'resolveFrom', 'installedVersion', 'adapterMajor', 'map'], path, {
    map: value.map.map((component, index) => normalizeComponent(component, `${path}.map[${index}]`, budget)),
  })
}

/** Validate and clone data-only adapter exports before reducer closures are created. */
export function normalizeAdapterManifestExports(
  exportsData: Record<string, unknown>,
  source: string,
) {
  const normalized: Record<string, unknown> = Object.create(null)
  const budget: NormalizationBudget = { members: 0, path: source }
  let aggregateComponents = 0
  for (const [key, value] of Object.entries(exportsData)) {
    if (['__proto__', 'prototype', 'constructor', 'then'].includes(key))
      throw new TypeError(`Unsafe adapter export key: ${source}#${key}`)
    if (!isPlainRecord(value))
      throw new TypeError(`Invalid adapter manifest export: ${source}#${key}`)
    const path = `${source}#${key}`
    const map = value.map
    if (Array.isArray(map)) {
      aggregateComponents += map.length
      if (aggregateComponents > maxAggregateComponents)
        invalid(`${source}.components`)
    }
    normalized[key] = key.endsWith('Components')
      ? normalizeComponentsExport(value, path, budget)
      : normalizePropsExport(value, path, budget)
  }
  return normalized
}
