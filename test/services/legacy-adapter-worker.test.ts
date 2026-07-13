import { afterEach, describe, expect, it } from 'vitest'
import { runLegacyAdapterInWorker, setLegacyWorkerDeadlineForTests } from '../../src/services/legacy-adapter-worker'

const limits = { maxExports: 10, maxSingleResultSize: 1024 * 1024, maxTotalResultSize: 2 * 1024 * 1024 }

describe('legacy adapter worker isolation', () => {
  afterEach(() => setLegacyWorkerDeadlineForTests(undefined))

  it('executes and streams normal compatibility adapters', async () => {
    const result = await runLegacyAdapterInWorker(
      'module.exports.ok = () => ({ value: 1 })',
      'normal.cjs',
      false,
      200,
      limits,
    )
    expect(result).toEqual([['ok', '{"value":1}']])
  })

  it('rejects oversized exports inside the worker before returning them', async () => {
    const script = 'module.exports.huge = () => ({ value: "x".repeat(2 * 1024 * 1024) })'
    await expect(runLegacyAdapterInWorker(script, 'huge.cjs', false, 500, limits))
      .rejects
      .toThrow(/per-export byte limit|memory limit|worker exited/i)
  })

  it('terminates an escaped nextTick loop without freezing the host', async () => {
    setLegacyWorkerDeadlineForTests(200)
    const malicious = `
      const hostProcess = this.constructor.constructor('return process')()
      hostProcess.nextTick(() => { while (true) {} })
      module.exports.ok = () => ({ ok: true })
    `
    const started = Date.now()
    await expect(runLegacyAdapterInWorker(malicious, 'escape.cjs', false, 100, limits))
      .rejects
      .toThrow(/deadline exceeded|execution failed/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
