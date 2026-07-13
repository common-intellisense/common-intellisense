import { Buffer } from 'node:buffer'
import { Worker } from 'node:worker_threads'

export interface LegacyAdapterWorkerLimits {
  maxExports: number
  maxSingleResultSize: number
  maxTotalResultSize: number
}

const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')

function fail(error) {
  parentPort.postMessage({ type: 'error', error: String(error && error.stack || error) })
}

try {
  const exportsObject = Object.create(null)
  const moduleObject = Object.create(null)
  moduleObject.exports = exportsObject
  const sandbox = Object.create(null)
  let totalBytes = 0
  let emitted = 0

  sandbox.module = moduleObject
  sandbox.exports = exportsObject
  sandbox.require = undefined
  sandbox.process = undefined
  sandbox.global = undefined
  sandbox.Function = undefined
  sandbox.eval = undefined
  sandbox.__localeZh = workerData.localeZh
  sandbox.__maxExports = workerData.limits.maxExports
  sandbox.__emit = (key, json) => {
    if (typeof key !== 'string' || typeof json !== 'string')
      throw new Error('Legacy adapter export is not JSON serializable')
    const bytes = Buffer.byteLength(json)
    if (bytes > workerData.limits.maxSingleResultSize)
      throw new Error('Legacy adapter export is too large: per-export byte limit exceeded')
    totalBytes += bytes
    emitted++
    if (emitted > workerData.limits.maxExports)
      throw new Error('Legacy adapter has too many exports')
    if (totalBytes > workerData.limits.maxTotalResultSize)
      throw new Error('Legacy adapter exceeds the total result byte limit')
    parentPort.postMessage({ type: 'export', key, json, bytes })
  }

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  new vm.Script(workerData.script, { filename: workerData.source }).runInContext(context, { timeout: workerData.vmTimeout })
  new vm.Script(
    "(() => { const blocked = new Set(['__proto__', 'prototype', 'constructor']); const keys = Object.keys(module.exports).filter(key => !blocked.has(key)); if (keys.length > __maxExports) throw new Error('Legacy adapter has too many exports'); for (const key of keys) { const value = module.exports[key]; const data = typeof value === 'function' ? value(key.endsWith('Components') ? __localeZh : undefined) : value; __emit(key, JSON.stringify(data)); } })()",
  ).runInContext(context, { timeout: workerData.vmTimeout })
  parentPort.postMessage({ type: 'done' })
}
catch (error) {
  fail(error)
}
`

let legacyWorkerDeadline = 3_000

export function setLegacyWorkerDeadlineForTests(timeout: number | undefined) {
  legacyWorkerDeadline = timeout ?? 3_000
}

/**
 * Execute legacy compatibility code outside the extension-host thread. A Worker
 * is not a security sandbox, but its external deadline and heap limits protect
 * the extension host from escaped queues and unbounded result allocation.
 */
export async function runLegacyAdapterInWorker(
  script: string,
  source: string,
  localeZh: boolean,
  vmTimeout: number,
  limits: LegacyAdapterWorkerLimits,
): Promise<Array<[string, string]>> {
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { script, source, localeZh, vmTimeout, limits },
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<Array<[string, string]>>((resolve, reject) => {
      let settled = false
      let totalBytes = 0
      const entries: Array<[string, string]> = []
      const finish = (callback: () => void) => {
        if (settled)
          return
        settled = true
        callback()
      }
      timer = setTimeout(() => {
        finish(() => reject(new Error(`Legacy adapter execution deadline exceeded: ${source}`)))
        void worker.terminate()
      }, legacyWorkerDeadline)
      timer.unref?.()
      worker.on('message', (message: { type?: string, key?: unknown, json?: unknown, bytes?: unknown, error?: unknown }) => {
        if (settled)
          return
        if (message?.type === 'export' && typeof message.key === 'string' && typeof message.json === 'string') {
          const bytes = Buffer.byteLength(message.json)
          totalBytes += bytes
          if (entries.length >= limits.maxExports || bytes > limits.maxSingleResultSize || totalBytes > limits.maxTotalResultSize) {
            finish(() => reject(new Error(`Legacy adapter result exceeds host byte limits: ${source}`)))
            void worker.terminate()
            return
          }
          entries.push([message.key, message.json])
          return
        }
        if (message?.type === 'done') {
          finish(() => resolve(entries))
          return
        }
        if (message?.type === 'error')
          finish(() => reject(new Error(`Legacy adapter execution failed: ${source}: ${String(message.error || 'invalid result')}`)))
      })
      worker.once('error', error => finish(() => reject(error)))
      worker.once('exit', (code) => {
        if (code !== 0)
          finish(() => reject(new Error(`Legacy adapter worker exited with code ${code}: ${source}`)))
      })
    })
  }
  finally {
    if (timer)
      clearTimeout(timer)
    await worker.terminate().catch(() => undefined)
  }
}
