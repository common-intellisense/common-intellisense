import vm from 'node:vm'

/**
 * Create the compatibility adapter context. `node:vm` is not a security
 * boundary; microtaskMode only keeps Promise callbacks inside runInContext's
 * timeout accounting.
 */
export function createAdapterVmContext(sandbox: vm.Context) {
  return vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
}

/** Execute and serialize every adapter export under one aggregate timeout. */
export function runAdapterExports(context: vm.Context, timeout: number) {
  // Derive all inputs inside the timed evaluation. Writing properties onto a
  // contextified object after adapter initialization could invoke an attacker-
  // controlled setter outside VM timeout accounting.
  return new vm.Script(`(() => {
    const output = []
    const blocked = new Set(['__proto__', 'prototype', 'constructor'])
    for (const key of Object.keys(module.exports)) {
      if (blocked.has(key)) continue
      const value = module.exports[key]
      const data = typeof value === 'function' ? value(key.endsWith('Components') ? __localeZh : undefined) : value
      output.push([key, JSON.stringify(data)])
    }
    return JSON.stringify(output)
  })()`).runInContext(context, { timeout }) as unknown
}
