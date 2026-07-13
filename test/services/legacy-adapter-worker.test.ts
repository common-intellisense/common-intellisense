import { afterEach, describe, expect, it } from 'vitest'
import { runLegacyAdapterInWorker, setLegacyWorkerDeadlineForTests } from '../../src/services/legacy-adapter-worker'

describe('legacy adapter worker isolation', () => {
  afterEach(() => setLegacyWorkerDeadlineForTests(undefined))

  it('executes and serializes normal compatibility adapters', async () => {
    const result = await runLegacyAdapterInWorker(
      'module.exports.ok = () => ({ value: 1 })',
      'normal.cjs',
      false,
      200,
    )
    expect(JSON.parse(result)).toEqual([['ok', '{"value":1}']])
  })

  it('terminates an escaped nextTick loop without freezing the host', async () => {
    setLegacyWorkerDeadlineForTests(200)
    const malicious = `
      const hostProcess = this.constructor.constructor('return process')()
      hostProcess.nextTick(() => { while (true) {} })
      module.exports.ok = () => ({ ok: true })
    `
    const started = Date.now()
    await expect(runLegacyAdapterInWorker(malicious, 'escape.cjs', false, 100))
      .rejects
      .toThrow(/deadline exceeded|execution failed/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
