type PlainRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Invalid adapter manifest field: ${path}`)
  return value
}

function normalizeNamedArray(value: unknown, path: string) {
  if (value === undefined)
    return []
  if (!Array.isArray(value))
    throw new TypeError(`Invalid adapter manifest field: ${path}`)
  return value.map((entry, index) => {
    if (!isPlainRecord(entry))
      throw new TypeError(`Invalid adapter manifest field: ${path}[${index}]`)
    requireNonEmptyString(entry.name, `${path}[${index}].name`)
    return { ...entry }
  })
}

function normalizeComponent(value: unknown, path: string) {
  if (!isPlainRecord(value))
    throw new TypeError(`Invalid adapter manifest field: ${path}`)
  requireNonEmptyString(value.name, `${path}.name`)
  if (value.props !== undefined && !isPlainRecord(value.props))
    throw new TypeError(`Invalid adapter manifest field: ${path}.props`)
  const props: PlainRecord = {}
  for (const [name, prop] of Object.entries(value.props || {})) {
    if (!isPlainRecord(prop))
      throw new TypeError(`Invalid adapter manifest field: ${path}.props.${name}`)
    if (prop.type !== undefined && typeof prop.type !== 'string')
      throw new TypeError(`Invalid adapter manifest field: ${path}.props.${name}.type`)
    if (prop.required !== undefined && typeof prop.required !== 'boolean')
      throw new TypeError(`Invalid adapter manifest field: ${path}.props.${name}.required`)
    props[name] = { ...prop }
  }
  return {
    ...value,
    props,
    events: normalizeNamedArray(value.events, `${path}.events`),
    methods: normalizeNamedArray(value.methods, `${path}.methods`),
    slots: normalizeNamedArray(value.slots, `${path}.slots`),
    exposed: normalizeNamedArray(value.exposed, `${path}.exposed`),
  }
}

function normalizeComponentsExport(value: PlainRecord, path: string) {
  requireNonEmptyString(value.lib, `${path}.lib`)
  if (!Array.isArray(value.map))
    throw new TypeError(`Invalid adapter manifest field: ${path}.map`)
  const map = value.map.map((entry, index) => {
    if (!Array.isArray(entry) || !entry.length)
      throw new TypeError(`Invalid adapter manifest field: ${path}.map[${index}]`)
    const component = entry[0]
    const normalizedComponent = typeof component === 'string'
      ? requireNonEmptyString(component, `${path}.map[${index}][0]`)
      : normalizeComponent(component, `${path}.map[${index}][0]`)
    if (entry[1] !== undefined && typeof entry[1] !== 'string')
      throw new TypeError(`Invalid adapter manifest field: ${path}.map[${index}][1]`)
    if (entry[2] !== undefined && typeof entry[2] !== 'string')
      throw new TypeError(`Invalid adapter manifest field: ${path}.map[${index}][2]`)
    return [normalizedComponent, ...entry.slice(1)]
  })
  return { ...value, map }
}

function normalizePropsExport(value: PlainRecord, path: string) {
  requireNonEmptyString(value.uiName, `${path}.uiName`)
  requireNonEmptyString(value.lib, `${path}.lib`)
  if (!Array.isArray(value.map))
    throw new TypeError(`Invalid adapter manifest field: ${path}.map`)
  return {
    ...value,
    map: value.map.map((component, index) => normalizeComponent(component, `${path}.map[${index}]`)),
  }
}

/** Validate and clone data-only adapter exports before reducer closures are created. */
export function normalizeAdapterManifestExports(exportsData: Record<string, unknown>, source: string) {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(exportsData)) {
    if (!isPlainRecord(value))
      throw new TypeError(`Invalid adapter manifest export: ${source}#${key}`)
    const path = `${source}#${key}`
    normalized[key] = key.endsWith('Components')
      ? normalizeComponentsExport(value, path)
      : normalizePropsExport(value, path)
  }
  return normalized
}
