import { fixedTagName, formatUIName, getUiImportedName } from '../ui/ui-utils'

export interface ComponentSourceScope {
  key: string
  /** Exact per-component module, for example `primevue/button`. */
  exactLib?: string
  /** Compatibility/canonical value when the adapter has exactly one lib. */
  lib?: string
  /** Package roots and wrappers may resolve to any library in this adapter. */
  acceptedLibs?: Set<string>
}

export interface ComponentSourceContext {
  cacheMap: Map<string, any>
  sourceScopes: Map<string, ComponentSourceScope>
}

export function isLocalModuleSource(source: string | undefined) {
  return !!source && (source.startsWith('.') || source.startsWith('/') || source.startsWith('file:') || source.startsWith('@/'))
}

export function getPackageSource(source: string) {
  return source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]
}

function exactVariants(source: string) {
  return [source, formatUIName(source)]
}

function sourceVariants(source: string) {
  const packageName = getPackageSource(source)
  return [...exactVariants(source), packageName, formatUIName(packageName)]
}

export function findComponentSourceScope(sourceScopes: Map<string, ComponentSourceScope> | undefined, source: string | undefined) {
  if (!sourceScopes || !source)
    return
  for (const variant of exactVariants(source)) {
    const scope = sourceScopes.get(variant)
    if (scope?.exactLib)
      return scope
  }
  for (const variant of sourceVariants(source)) {
    const scope = sourceScopes.get(variant)
    if (!scope)
      continue
    const suffix = source.slice(getPackageSource(source).length).replace(/^\//, '')
    if (suffix && scope.acceptedLibs) {
      const exactLib = [...scope.acceptedLibs].find(lib => lib.slice(getPackageSource(lib).length).replace(/^\//, '') === suffix)
      if (exactLib)
        return { ...scope, exactLib }
    }
    return scope
  }
}

export function sourceScopeAccepts(scope: ComponentSourceScope | undefined, lib: unknown) {
  if (!scope)
    return true
  if (typeof lib !== 'string')
    return false
  if (scope.exactLib)
    return lib === scope.exactLib
  return !scope.acceptedLibs?.size || scope.acceptedLibs.has(lib)
}

export interface ImportedTagResolution {
  rawTag: string
  localRoot: string
  importedRoot: string
  members: string[]
  source?: string
  candidates: string[]
}

/** Preserve a compound tag's imported root before deriving flattened lookup names. */
export function resolveImportedTag(rawTag: string, deps: Record<string, string> | undefined): ImportedTagResolution {
  const [root, ...members] = rawTag.split('.').filter(Boolean)
  const localRoot = root || rawTag
  const mappedRoot = getUiImportedName(deps, localRoot)
  const importedRoot = mappedRoot === '*' ? localRoot : mappedRoot
  const rawDotted = [localRoot, ...members].join('.')
  const importedDotted = [importedRoot, ...members].join('.')
  const source = deps?.[localRoot]
  const sourceTail = source && !members.length && importedRoot === localRoot && !isLocalModuleSource(source)
    ? source.split(/[?#]/)[0].split('/').filter(Boolean).at(-1)
    : undefined
  const candidates = [rawDotted, importedDotted, fixedTagName(rawDotted), fixedTagName(importedDotted), sourceTail, sourceTail ? fixedTagName(sourceTail) : undefined]
  if (members.length)
    candidates.push(members.join('.'), fixedTagName(members.join('.')))
  return { rawTag, localRoot, importedRoot, members, source, candidates: [...new Set(candidates.filter((candidate): candidate is string => !!candidate))] }
}
