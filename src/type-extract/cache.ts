type CachedTypeResult = Record<string, () => any>

class TypeCache {
  private readonly cache = new Map<string, CachedTypeResult>()
  private readonly inFlight = new Map<string, Promise<CachedTypeResult | undefined>>()
  private readonly order: string[] = []
  private readonly maxEntries: number
  private epoch = 0

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries
  }

  get(key: string) {
    const value = this.cache.get(key)
    if (!value)
      return
    this.touch(key)
    return value
  }

  set(key: string, value: CachedTypeResult) {
    this.cache.set(key, value)
    this.touch(key)
    this.prune()
  }

  has(key: string) {
    return this.cache.has(key)
  }

  clear() {
    this.epoch++
    this.cache.clear()
    this.inFlight.clear()
    this.order.length = 0
  }

  getEpoch() {
    return this.epoch
  }

  getInFlight(key: string) {
    return this.inFlight.get(key)
  }

  setInFlight(key: string, promise: Promise<CachedTypeResult | undefined>) {
    this.inFlight.set(key, promise)
  }

  clearInFlight(key: string) {
    this.inFlight.delete(key)
  }

  prune() {
    while (this.order.length > this.maxEntries) {
      const key = this.order.shift()
      if (!key)
        continue
      this.cache.delete(key)
    }
  }

  private touch(key: string) {
    const index = this.order.indexOf(key)
    if (index >= 0)
      this.order.splice(index, 1)
    this.order.push(key)
  }
}

export const typeCache = new TypeCache(20)

export function clearTypeCache() {
  typeCache.clear()
}
