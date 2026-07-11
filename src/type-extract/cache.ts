type CachedTypeResult = Record<string, () => any>

interface TypeFileSnapshot {
  files: string[]
}

export class TypeCache {
  private readonly cache = new Map<string, CachedTypeResult>()
  private readonly inFlight = new Map<string, Promise<CachedTypeResult | undefined>>()
  private readonly order: string[] = []
  private readonly snapshots = new Map<string, TypeFileSnapshot>()
  private readonly snapshotOrder: string[] = []
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
    this.snapshots.clear()
    this.snapshotOrder.length = 0
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

  clearInFlight(key: string, expected?: Promise<CachedTypeResult | undefined>) {
    if (!expected || this.inFlight.get(key) === expected)
      this.inFlight.delete(key)
  }

  getSnapshot(key: string) {
    const snapshot = this.snapshots.get(key)
    if (snapshot)
      this.touchSnapshot(key)
    return snapshot
  }

  setSnapshot(key: string, files: string[]) {
    this.snapshots.set(key, { files: [...new Set(files)].sort() })
    this.touchSnapshot(key)
    this.pruneSnapshots()
  }

  hasSnapshot(key: string) {
    return this.snapshots.has(key)
  }

  getSnapshotSize() {
    return this.snapshots.size
  }

  prune() {
    while (this.order.length > this.maxEntries) {
      const key = this.order.shift()
      if (!key)
        continue
      this.cache.delete(key)
    }
  }

  private pruneSnapshots() {
    while (this.snapshotOrder.length > this.maxEntries) {
      const key = this.snapshotOrder.shift()
      if (key)
        this.snapshots.delete(key)
    }
  }

  private touchSnapshot(key: string) {
    const index = this.snapshotOrder.indexOf(key)
    if (index >= 0)
      this.snapshotOrder.splice(index, 1)
    this.snapshotOrder.push(key)
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
