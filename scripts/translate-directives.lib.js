const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const fg = require('fast-glob')

function hasChineseCharacters(str) {
  const pattern = /[\u4E00-\u9FA5]/
  return pattern.test(str)
}

function makeUnifiedDiff(a, b) {
  const aa = a.split('\n')
  const bb = b.split('\n')
  const max = Math.max(aa.length, bb.length)
  const lines = []
  for (let i = 0; i < max; i++) {
    const A = aa[i] === undefined ? '' : aa[i]
    const B = bb[i] === undefined ? '' : bb[i]
    if (A === B) {
      lines.push(' ' + A)
    }
    else {
      if (A) lines.push('-' + A)
      if (B) lines.push('+' + B)
    }
  }
  return lines.join('\n')
}

async function runTranslate(options = {}) {
  const root = process.cwd()
  const CLI_DIR = options.dir ? path.resolve(root, options.dir) : null
  const cwd = CLI_DIR || path.resolve(root, 'src/ui/varlet')
  const DRY_RUN = options.apply ? false : true
  const VERBOSE = !!options.verbose
  const REPORT_PATH = options.report ? (options.reportPath ? path.resolve(root, options.reportPath) : path.resolve(root, 'translate-directives-report.json')) : null

  const reportEntries = []
  const useDiff = !!options.diff
  let processedCount = 0
  let stack = 0
  const limit = 10
  const hasDone = new Set()

  const isTestEnv = !!(process.env.VITEST || process.env.NODE_ENV === 'test')
  let warnedTranslateFailure = false
  // translation backend (optional)
  let translate
  if (typeof options.translate === 'function') {
    translate = options.translate
  }
  else if (options.noTranslate || isTestEnv) {
    translate = (text, _from, _to) => Promise.resolve({ translation: text })
  }
  else {
    try {
      const mod = require('bing-translate-api')
      translate = mod.translate || mod
    }
    catch (err) {
      translate = (text, _from, _to) => Promise.resolve({ translation: text })
    }
  }

  const cacheMap = new Map()
  function fanyi(text) {
    if (!text)
      return Promise.resolve('')
    if (cacheMap.has(text))
      return cacheMap.get(text)

    const p = new Promise((resolve, reject) => {
      const doResolve = (res) => {
        const result = (res && (res.translation || res) || '') + ''
        if (VERBOSE)
          console.log(`[translate] "${text}" => "${result}"`)
        resolve(result)
      }
      const doReject = (err) => {
        if (!warnedTranslateFailure && !isTestEnv) {
          console.warn('translate-directives: translation failed; falling back to original text')
          warnedTranslateFailure = true
        }
        if (VERBOSE && err) {
          const msg = err && (err.message || err.toString()) || err
          console.warn(`[translate] failed for "${text}": ${msg}`)
        }
        resolve(text)
      }
      try {
        if (hasChineseCharacters(text)) {
          translate(text, null, 'en').then(doResolve).catch(doReject)
        }
        else {
          translate(text, null, 'zh-Hans').then(doResolve).catch(doReject)
        }
      }
      catch (err) { doReject(err) }
    })

    cacheMap.set(text, p)
    return p
  }

  // find files
  const entry = await fg(['**/directives.json'], { dot: true, cwd })
  const rest = entry.map((url) => path.resolve(cwd, url)).filter(Boolean)
  if (!rest.length) {
    return { processedCount: 0, report: [] }
  }

  for (const newUrl of rest) {
    if (hasDone.has(newUrl)) continue
    const content = await fsp.readFile(newUrl, 'utf8')
    if (!content) continue
    const originalContent = content
    const obj = JSON.parse(content)

    // process entries - only handle array-type entries (e.g. "directives")
    for (const key in obj) {
      const value = obj[key]
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (hasChineseCharacters(item.description)) {
          item.description_zh = item.description
          try { item.description = await fanyi(item.description) }
          catch (err) { if (stack >= limit) return { processedCount, report: reportEntries }; stack++; setTimeout(()=>{}, 0); return }
        }
        if (!hasChineseCharacters(item.description_zh)) {
          try { item.description_zh = await fanyi(item.description) }
          catch (err) { if (stack >= limit) return { processedCount, report: reportEntries }; stack++; setTimeout(()=>{}, 0); return }
        }
        if (item.params && item.params.length) {
          for (const child of item.params) {
            if (hasChineseCharacters(child.description)) {
              child.description_zh = child.description
              try { child.description = await fanyi(child.description) }
              catch (err) { if (stack >= limit) return { processedCount, report: reportEntries }; stack++; setTimeout(()=>{}, 0); return }
            }
            if (!hasChineseCharacters(child.description_zh)) {
              try { child.description_zh = await fanyi(child.description) }
              catch (err) { if (stack >= limit) return { processedCount, report: reportEntries }; stack++; setTimeout(()=>{}, 0); return }
            }
          }
        }
      }
    }

    // props
    const propsObj = obj.props || {}
    for (const key in propsObj) {
      const value = propsObj[key]
      if (!value.description) value.description = ''
      if (!value.value) value.value = ''
      if (hasChineseCharacters(value.description)) {
        value.description_zh = value.description
        try { value.description = await fanyi(value.description) }
        catch (err) { if (stack >= limit) return { processedCount, report: reportEntries }; stack++; setTimeout(()=>{}, 0); return }
      }
      if (!hasChineseCharacters(value.description_zh)) {
        try { value.description_zh = await fanyi(value.description) }
        catch (err) { if (stack >= limit) return { processedCount, report: reportEntries }; stack++; setTimeout(()=>{}, 0); return }
      }
    }

    // finalize
    try {
      hasDone.add(newUrl)
      const data = JSON.stringify(obj, null, 2)
      if (DRY_RUN) {
        processedCount++
        if (REPORT_PATH) reportEntries.push({ file: newUrl, diff: useDiff ? makeUnifiedDiff(originalContent, data) : { original: originalContent, updated: data } })
      } else {
        await fsp.writeFile(newUrl, data)
        processedCount++
        if (REPORT_PATH) reportEntries.push({ file: newUrl, diff: useDiff ? makeUnifiedDiff(originalContent, data) : { original: originalContent, updated: data } })
      }
    }
    catch (err) {
      stack++
      return { processedCount, report: reportEntries }
    }
  }

  // write report if requested
  if (REPORT_PATH && reportEntries.length) {
    await fsp.writeFile(REPORT_PATH, JSON.stringify(reportEntries, null, 2))
  }

  return { processedCount, report: reportEntries }
}

module.exports = { runTranslate }
