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

export function findPrefixedComponent(componentName: string, prefixes: string[], UiCompletions: any): any {
  if (!UiCompletions)
    return null

  for (const prefix of prefixes) {
    const standardName = convertPrefixedComponentName(componentName, prefix)
    if (standardName && UiCompletions[standardName])
      return UiCompletions[standardName]
  }

  if (UiCompletions && UiCompletions[componentName])
    return UiCompletions[componentName]

  const want = componentName.toLowerCase()
  for (const key of Object.keys(UiCompletions)) {
    if (key.toLowerCase().endsWith(want))
      return UiCompletions[key]
  }

  return null
}

export default findPrefixedComponent
