type PlainRecord = Record<string, unknown>

const maxComponentsPerLibrary = 5_000
const maxComponentMembers = 1_000
const maxAggregateComponents = 10_000
const maxDomainStringLength = 100_000
const reservedComponentNames = new Set(['__proto__', 'prototype', 'constructor', 'then', 'icons'])

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(path: string): never {
  throw new TypeError(`Invalid adapter manifest field: ${path}`)
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxDomainStringLength)
    invalid(path)
  return value
}

function requireSafeComponentName(value: unknown, path: string) {
  const name = requireNonEmptyString(value, path)
  if (reservedComponentNames.has(name))
    invalid(path)
  return name
}

function validateOptionalString(record: PlainRecord, key: string, path: string) {
  if (record[key] !== undefined && (typeof record[key] !== 'string' || record[key].length > maxDomainStringLength))
    invalid(`${path}.${key}`)
}

function validateOptionalBoolean(record: PlainRecord, key: string, path: string) {
  if (record[key] !== undefined && typeof record[key] !== 'boolean')
    invalid(`${path}.${key}`)
}

function normalizeParams(value: unknown, path: string) {
  if (value === undefined)
    return undefined
  if (typeof value === 'string')
    return value
  if (!Array.isArray(value))
    invalid(path)
  return value.map((entry, index) => {
    if (typeof entry === 'string')
      return entry
    if (!isPlainRecord(entry))
      invalid(`${path}[${index}]`)
    for (const key of ['name', 'description', 'description_zh', 'type', 'default'])
      validateOptionalString(entry, key, `${path}[${index}]`)
    return { ...entry }
  })
}

function normalizeTypeDetail(value: unknown, path: string) {
  if (value === undefined)
    return undefined
  if (!isPlainRecord(value))
    invalid(path)
  const normalized: PlainRecord = {}
  for (const [key, detail] of Object.entries(value)) {
    if (typeof detail === 'string') {
      normalized[key] = detail
      continue
    }
    if (!Array.isArray(detail))
      invalid(`${path}.${key}`)
    normalized[key] = detail.map((entry, index) => {
      if (!isPlainRecord(entry))
        invalid(`${path}.${key}[${index}]`)
      for (const field of ['name', 'description', 'description_zh', 'type', 'params', 'value'])
        validateOptionalString(entry, field, `${path}.${key}[${index}]`)
      validateOptionalBoolean(entry, 'optional', `${path}.${key}[${index}]`)
      return { ...entry }
    })
  }
  return normalized
}

function normalizeSuggestions(value: unknown, path: string) {
  if (value === undefined)
    return []
  if (!Array.isArray(value))
    invalid(path)
  return value.map((entry, index) => {
    if (typeof entry === 'string')
      return requireNonEmptyString(entry, `${path}[${index}]`)
    if (!isPlainRecord(entry))
      invalid(`${path}[${index}]`)
    requireNonEmptyString(entry.name, `${path}[${index}].name`)
    validateOptionalString(entry, 'description', `${path}[${index}]`)
    validateOptionalString(entry, 'description_zh', `${path}[${index}]`)
    return { ...entry }
  })
}

function normalizeNamedArray(value: unknown, path: string, eventEntries = false) {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.length > maxComponentMembers)
    invalid(path)
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`
    if (!isPlainRecord(entry))
      invalid(entryPath)
    requireNonEmptyString(entry.name, `${entryPath}.name`)
    for (const key of ['description', 'description_zh', 'version', 'detail', 'platform', 'value'])
      validateOptionalString(entry, key, entryPath)
    if (eventEntries && entry.kind !== undefined && entry.kind !== 'dom' && entry.kind !== 'component')
      invalid(`${entryPath}.kind`)
    if (eventEntries)
      validateOptionalBoolean(entry, 'required', entryPath)
    const params = normalizeParams(entry.params, `${entryPath}.params`)
    if (!eventEntries)
      return { ...entry, params }
    // Events are consumed directly by snippet generation. Clone only the public
    // event contract so unknown manifest fields cannot silently activate future
    // reducer behavior.
    return {
      name: entry.name,
      description: entry.description,
      description_zh: entry.description_zh,
      version: entry.version,
      detail: entry.detail,
      platform: entry.platform,
      value: entry.value,
      params,
      kind: entry.kind,
      required: entry.required,
    }
  })
}

function normalizeProp(prop: PlainRecord, path: string) {
  for (const key of ['type', 'version', 'description', 'description_zh', 'platform'])
    validateOptionalString(prop, key, path)
  for (const key of ['required', 'foreach'])
    validateOptionalBoolean(prop, key, path)
  if (prop.related !== undefined && (!Array.isArray(prop.related) || prop.related.some(item => typeof item !== 'string')))
    invalid(`${path}.related`)
  if (Array.isArray(prop.value) && prop.value.some(item => typeof item !== 'string'))
    invalid(`${path}.value`)
  const typeDetail = normalizeTypeDetail(prop.typeDetail, `${path}.typeDetail`)
  for (const [key, value] of Object.entries(prop)) {
    if (key.startsWith('$') && typeof value !== 'string')
      invalid(`${path}.${key}`)
  }
  return { ...prop, typeDetail }
}

function normalizeComponent(value: unknown, path: string) {
  if (!isPlainRecord(value))
    invalid(path)
  requireSafeComponentName(value.name, `${path}.name`)
  for (const key of ['description', 'description_zh', 'tag', 'link', 'link_zh', 'dynamicLib', 'version'])
    validateOptionalString(value, key, path)
  if (value.importWay !== undefined && !['as default', 'default', 'specifier'].includes(String(value.importWay)))
    invalid(`${path}.importWay`)
  if (value.props !== undefined && (!isPlainRecord(value.props) || Object.keys(value.props).length > maxComponentMembers))
    invalid(`${path}.props`)
  const props: PlainRecord = Object.create(null)
  for (const [name, prop] of Object.entries(value.props || {})) {
    if (!name.trim() || (name.startsWith(':') && name.length < 2))
      invalid(`${path}.props.${name || '<empty>'}`)
    if (!isPlainRecord(prop))
      invalid(`${path}.props.${name}`)
    props[name] = normalizeProp(prop, `${path}.props.${name}`)
  }
  return {
    ...value,
    props,
    events: normalizeNamedArray(value.events, `${path}.events`, true),
    methods: normalizeNamedArray(value.methods, `${path}.methods`),
    slots: normalizeNamedArray(value.slots, `${path}.slots`),
    exposed: normalizeNamedArray(value.exposed, `${path}.exposed`),
    suggestions: normalizeSuggestions(value.suggestions, `${path}.suggestions`),
    typeDetail: normalizeTypeDetail(value.typeDetail, `${path}.typeDetail`),
  }
}

function isSafeDirectiveValue(value: unknown) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function normalizeDirectives(value: unknown, path: string) {
  if (value === undefined)
    return undefined
  if (!Array.isArray(value))
    invalid(path)
  return value.map((directive, index) => {
    const directivePath = `${path}[${index}]`
    if (!isPlainRecord(directive))
      invalid(directivePath)
    requireNonEmptyString(directive.name, `${directivePath}.name`)
    for (const key of ['description', 'description_zh', 'documentation', 'documentationType', 'link', 'version'])
      validateOptionalString(directive, key, directivePath)
    if (directive.params !== undefined && !Array.isArray(directive.params))
      invalid(`${directivePath}.params`)
    const params = (directive.params || []).map((param, paramIndex) => {
      const paramPath = `${directivePath}.params[${paramIndex}]`
      if (!isPlainRecord(param))
        invalid(paramPath)
      requireNonEmptyString(param.name, `${paramPath}.name`)
      requireNonEmptyString(param.type, `${paramPath}.type`)
      for (const key of ['description', 'description_zh'])
        validateOptionalString(param, key, paramPath)
      for (const key of ['default', 'value']) {
        if (param[key] !== undefined && !isSafeDirectiveValue(param[key]))
          invalid(`${paramPath}.${key}`)
      }
      return { ...param }
    })
    return { ...directive, params }
  })
}

function normalizeComponentsExport(value: PlainRecord, path: string) {
  requireNonEmptyString(value.lib, `${path}.lib`)
  for (const key of ['prefix', 'dynamicLib'])
    validateOptionalString(value, key, path)
  if (value.importWay !== undefined && !['as default', 'default', 'specifier'].includes(String(value.importWay)))
    invalid(`${path}.importWay`)
  if (!Array.isArray(value.map) || value.map.length > maxComponentsPerLibrary)
    invalid(`${path}.map`)
  const map = value.map.map((entry, index) => {
    if (!Array.isArray(entry) || !entry.length)
      invalid(`${path}.map[${index}]`)
    const component = entry[0]
    const normalizedComponent = typeof component === 'string'
      ? requireSafeComponentName(component, `${path}.map[${index}][0]`)
      : normalizeComponent(component, `${path}.map[${index}][0]`)
    if (entry[1] !== undefined && typeof entry[1] !== 'string')
      invalid(`${path}.map[${index}][1]`)
    if (entry[2] !== undefined && typeof entry[2] !== 'string')
      invalid(`${path}.map[${index}][2]`)
    return [normalizedComponent, ...entry.slice(1)]
  })
  return { ...value, map, directives: normalizeDirectives(value.directives, `${path}.directives`) }
}

function normalizePropsExport(value: PlainRecord, path: string) {
  requireNonEmptyString(value.uiName, `${path}.uiName`)
  requireNonEmptyString(value.lib, `${path}.lib`)
  for (const key of ['prefix', 'dynamicLib', 'resolveFrom', 'installedVersion', 'adapterMajor'])
    validateOptionalString(value, key, path)
  if (!Array.isArray(value.map) || value.map.length > maxComponentsPerLibrary)
    invalid(`${path}.map`)
  return { ...value, map: value.map.map((component, index) => normalizeComponent(component, `${path}.map[${index}]`)) }
}

/** Validate and clone data-only adapter exports before reducer closures are created. */
export function normalizeAdapterManifestExports(exportsData: Record<string, unknown>, source: string) {
  const normalized: Record<string, unknown> = {}
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
      ? normalizeComponentsExport(value, path)
      : normalizePropsExport(value, path)
  }
  return normalized
}
