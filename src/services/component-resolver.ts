import { fixedTagName, formatUIName, getUiImportedName } from '../ui/ui-utils'

export interface ComponentSourceScope {
  key: string
  lib: string
}

export interface ComponentSourceContext {
  cacheMap: Map<string, any>
  sourceScopes: Map<string, ComponentSourceScope>
}

function sourceVariants(source: string) {
  const packageName = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]
  return [source, packageName, formatUIName(source), formatUIName(packageName)]
}

export function findComponentSourceScope(sourceScopes: Map<string, ComponentSourceScope> | undefined, source: string | undefined) {
  if (!sourceScopes || !source)
    return
  for (const variant of sourceVariants(source)) {
    const scope = sourceScopes.get(variant)
    if (scope)
      return scope
  }
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
  const [localRoot, ...members] = rawTag.split('.').filter(Boolean)
  const mappedRoot = getUiImportedName(deps, localRoot)
  const importedRoot = mappedRoot === '*' ? localRoot : mappedRoot
  const rawDotted = [localRoot, ...members].join('.')
  const importedDotted = [importedRoot, ...members].join('.')
  const candidates = [
    rawDotted,
    importedDotted,
    fixedTagName(rawDotted),
    fixedTagName(importedDotted),
  ]
  // A member-only fallback is safe only after callers have selected the explicit source scope.
  if (members.length)
    candidates.push(members.join('.'), fixedTagName(members.join('.')))
  return {
    rawTag,
    localRoot,
    importedRoot,
    members,
    source: deps?.[localRoot],
    candidates: [...new Set(candidates.filter(Boolean))],
  }
}
