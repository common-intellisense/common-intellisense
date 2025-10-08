import path from 'node:path'
import fs from 'node:fs'
import { expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..')
const fixtureDir = path.resolve(repoRoot, 'test/fixtures/translate-test/src/ui/varlet')
const reportPath = path.resolve(repoRoot, 'translate-directives-report.json')

it('translate-directives script dry-run produces report', async () => {
  // remove existing report
  try { fs.unlinkSync(reportPath) }
  catch {}

  const { runTranslate } = require('../../scripts/translate-directives.lib')
  let res
  try {
    res = await runTranslate({ dir: fixtureDir, report: true, verbose: false, apply: false, reportPath })

    expect(res.processedCount).toBeGreaterThan(0)
    expect(Array.isArray(res.report)).toBeTruthy()
    expect(res.report.length).toBeGreaterThan(0)

    // report file should have been written
    expect(fs.existsSync(reportPath)).toBeTruthy()
    // verify the on-disk report matches the returned report
    const onDisk = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    expect(Array.isArray(onDisk)).toBeTruthy()
    expect(onDisk.length).toBeGreaterThan(0)
    expect(onDisk).toEqual(res.report)

    // crude content assertion: original content should include a known Chinese phrase
    // stronger assertions for each report entry
    for (const entry of res.report) {
      expect(entry).toHaveProperty('file')
      expect(typeof entry.file).toBe('string')
      // file should live under the fixture dir
      expect(entry.file.startsWith(fixtureDir)).toBeTruthy()

      expect(entry).toHaveProperty('diff')
      const d = entry.diff
      expect(d).toBeDefined()
      if (typeof d === 'string') {
        expect(d.length).toBeGreaterThan(0)
      }
      else {
        expect(d).toHaveProperty('original')
        expect(d).toHaveProperty('updated')
        expect(typeof d.original).toBe('string')
        expect(typeof d.updated).toBe('string')
        expect(d.original.length).toBeGreaterThan(0)
        expect(d.updated.length).toBeGreaterThan(0)
      }
    }
  }
  finally {
    // cleanup report file
    try { fs.unlinkSync(reportPath) }
    catch {}
  }
})
