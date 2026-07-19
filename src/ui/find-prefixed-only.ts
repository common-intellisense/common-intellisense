/**
 * Lightweight helper for tests: findPrefixedComponent without importing heavy deps.
 * This mirrors the matching logic used by the full implementation but avoids
 * pulling in translate/vscode and other runtime-only modules.
 */
export function convertPrefixedComponentName(componentName: string, prefix: string): string | null {
  if (!prefix)
    return componentName
  // Create a simple PascalCase prefixed name, e.g. 'el' + 'Pagination' -> 'ElPagination'
  const pref = prefix[0].toUpperCase() + prefix.slice(1)
  return `${pref}${componentName}`
}

export function findUniqueSuffixComponentKey(componentName: string, keys: string[], accepts: (key: string) => boolean = () => true): string | null {
  const want = componentName.toLowerCase()
  const matches = keys.filter(key => key.toLowerCase().endsWith(want) && accepts(key))
  return matches.length === 1 ? matches[0] : null
}

export function findPrefixedComponent(componentName: string, prefixes: string[], UiCompletions: any): any {
  if (!UiCompletions)
    return null

  for (const prefix of prefixes) {
    const pascalPrefix = prefix[0]?.toUpperCase() + prefix.slice(1)
    const exactPrefixedKey = `${pascalPrefix}${componentName[0]?.toUpperCase()}${componentName.slice(1)}`
    if (UiCompletions[exactPrefixedKey])
      return UiCompletions[exactPrefixedKey]

    const standardName = convertPrefixedComponentName(componentName, prefix)
    if (standardName && UiCompletions[standardName])
      return UiCompletions[standardName]
  }

  if (UiCompletions[componentName])
    return UiCompletions[componentName]

  const match = findUniqueSuffixComponentKey(componentName, Object.keys(UiCompletions))
  return match ? UiCompletions[match] : null
}

export default findPrefixedComponent
