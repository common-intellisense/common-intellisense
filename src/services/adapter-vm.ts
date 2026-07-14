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

const defaultMaxSerializedResultSize = 8 * 1024 * 1024

/**
 * Execute and serialize every adapter export under one aggregate timeout.
 * Production legacy adapters use the bounded Worker path; this compatibility
 * helper retains its own aggregate cap so future callers cannot bypass it.
 */
export function runAdapterExports(context: vm.Context, timeout: number, maxSerializedResultSize = defaultMaxSerializedResultSize) {
  if (!Number.isSafeInteger(maxSerializedResultSize) || maxSerializedResultSize <= 0)
    throw new TypeError('Invalid adapter result size limit')

  // Derive all inputs inside the timed evaluation. Writing properties onto a
  // contextified object after adapter initialization could invoke an attacker-
  // controlled setter outside VM timeout accounting.
  const source = `(() => {
    const output = []
    const blocked = new Set(['__proto__', 'prototype', 'constructor', 'then'])
    let serializedSize = 0
    for (const key of Object.keys(module.exports)) {
      if (blocked.has(key)) continue
      const value = module.exports[key]
      const data = typeof value === 'function' ? value(key.endsWith('Components') ? __localeZh : undefined) : value
      const json = JSON.stringify(data)
      if (typeof json !== 'string') throw new Error('Adapter export is not JSON serializable')
      serializedSize += key.length + json.length
      if (serializedSize > ${maxSerializedResultSize}) throw new Error('Adapter results exceed the serialized size limit')
      output.push([key, json])
    }
    const serialized = JSON.stringify(output)
    if (serialized.length > ${maxSerializedResultSize}) throw new Error('Adapter results exceed the serialized size limit')
    return serialized
  })()`
  return new vm.Script(source).runInContext(context, { timeout }) as unknown
}
