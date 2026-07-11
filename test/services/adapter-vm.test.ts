import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

function compileHelper() {
  const source = fs.readFileSync(path.resolve('src/services/adapter-vm.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'common-intellisense-vm-'))
  const filename = path.join(directory, 'adapter-vm.cjs')
  fs.writeFileSync(filename, output)
  return { directory, filename }
}

function runFixture(mode: 'malicious' | 'normal') {
  const { directory, filename } = compileHelper()
  try {
    const fixture = String.raw`
      const vm = require('node:vm')
      const { createAdapterVmContext } = require(process.argv[1])
      const sandbox = { module: { exports: {} }, exports: {}, marker: false }
      sandbox.exports = sandbox.module.exports
      const context = createAdapterVmContext(sandbox)
      const body = process.argv[2] === 'malicious'
        ? "module.exports.example = () => { Promise.resolve().then(() => { while (true) {} }); return {} }"
        : "module.exports.example = () => { Promise.resolve().then(() => { marker = true }); return {} }"
      new vm.Script(body).runInContext(context, { timeout: 100 })
      try {
        new vm.Script('JSON.stringify(module.exports.example())').runInContext(context, { timeout: 100 })
        process.stdout.write(sandbox.marker ? 'DRAINED' : 'NOT_DRAINED')
      } catch (error) {
        process.stdout.write(error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'TIMEOUT' : String(error))
      }
    `
    return execFileSync(process.execPath, ['-e', fixture, filename, mode], {
      encoding: 'utf8',
      timeout: 3000,
    })
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

describe('legacy adapter VM microtasks', () => {
  it('keeps a Promise microtask infinite loop inside the VM timeout', () => {
    expect(runFixture('malicious')).toBe('TIMEOUT')
  })

  it('drains normal Promise microtasks before runInContext returns', () => {
    expect(runFixture('normal')).toBe('DRAINED')
  })
})
