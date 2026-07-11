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
