const typeCache = new Map<string, Record<string, () => any>>()

export function clearTypeCache() {
  typeCache.clear()
}

export { typeCache }
