import { Worker } from 'node:worker_threads'

const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')

function fail(error) {
  parentPort.postMessage({ ok: false, error: String(error && error.stack || error) })
}

try {
  const exportsObject = Object.create(null)
  const moduleObject = Object.create(null)
  moduleObject.exports = exportsObject
  const sandbox = Object.create(null)
  sandbox.module = moduleObject
  sandbox.exports = exportsObject
  sandbox.require = undefined
  sandbox.process = undefined
  sandbox.global = undefined
  sandbox.Function = undefined
  sandbox.eval = undefined
  sandbox.__localeZh = workerData.localeZh

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  new vm.Script(workerData.script, { filename: workerData.source }).runInContext(context, { timeout: workerData.vmTimeout })
  const serialized = new vm.Script(
    "(() => { const output = []; const blocked = new Set(['__proto__', 'prototype', 'constructor']); for (const key of Object.keys(module.exports)) { if (blocked.has(key)) continue; const value = module.exports[key]; const data = typeof value === 'function' ? value(key.endsWith('Components') ? __localeZh : undefined) : value; output.push([key, JSON.stringify(data)]); } return JSON.stringify(output); })()",
  ).runInContext(context, { timeout: workerData.vmTimeout })
  parentPort.postMessage({ ok: true, serialized })
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
 * is not a security sandbox, but its external wall-clock deadline guarantees
 * that escaped timers/nextTick loops cannot freeze the extension host.
 */
export async function runLegacyAdapterInWorker(script: string, source: string, localeZh: boolean, vmTimeout: number) {
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { script, source, localeZh, vmTimeout },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false
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
      worker.once('message', (message: { ok?: boolean, serialized?: unknown, error?: unknown }) => {
        finish(() => {
          if (message?.ok && typeof message.serialized === 'string')
            resolve(message.serialized)
          else
            reject(new Error(`Legacy adapter execution failed: ${source}: ${String(message?.error || 'invalid result')}`))
        })
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
