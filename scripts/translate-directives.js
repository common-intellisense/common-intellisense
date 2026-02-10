#!/usr/bin/env node
'use strict'
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const fg = require('fast-glob')

const root = process.cwd()
// By default run in dry-run mode. Pass --apply to actually write files.
const DRY_RUN = !process.argv.includes('--apply')
const VERBOSE = process.argv.includes('--verbose')
// When --report is passed, write a JSON report of planned changes to this file
const REPORT_PATH = process.argv.includes('--report') ? path.resolve(root, 'translate-directives-report.json') : null
let processedCount = 0
const reportEntries = []
// Optional override for directory containing src/ui/varlet (useful for tests)
const CLI_DIR = (() => {
  const idx = process.argv.indexOf('--dir')
  if (idx !== -1 && process.argv[idx + 1])
    return path.resolve(root, process.argv[idx + 1])
  return null
})()

let stack = 0
const limit = 10
const hasDone = new Set()

async function setup() {
  const cwd = CLI_DIR || path.resolve(root, 'src/ui/varlet')
  const entry = await fg(['**/directives.json'], { dot: true, cwd })
  const rest = entry.map((url) => {
    const newUrl = path.resolve(cwd, url)
    if (hasDone.has(newUrl))
      return
    return newUrl
  }).filter(Boolean)
  const entryLength = entry.length
  // Helpful message when there are no directives files to process
  if (!rest.length) {
    console.log('translate-directives: no directives.json files found under src/ui/varlet')
    return
  }
  stack--
  console.log(rest)

  await Promise.all(rest.map(async (newUrl) => {
    if (hasDone.has(newUrl))
      return
    const content = await fsp.readFile(newUrl, 'utf8')
    if (!content)
      return
    const originalContent = content
    const obj = JSON.parse(content)

    for (const key in obj) {
      const value = obj[key]
      for (const item of value) {
        if (hasChineseCharacters(item.description)) {
          // preserve original Chinese as zh description
          item.description_zh = item.description
          try {
            item.description = await fanyi(item.description)
          }
          catch (error) {
            if (stack >= limit)
              return
            stack++
            console.log('reload', newUrl)
            setTimeout(setup, 500)
            return
          }
        }
        if (!hasChineseCharacters(item.description_zh)) {
          try {
            item.description_zh = await fanyi(item.description)
          }
          catch (error) {
            if (stack >= limit)
              return
            stack++
            console.log('reload', newUrl)
            setTimeout(setup, 500)
            return
          }
        }
        if (item.params && item.params.length) {
          for (const child of item.params) {
            if (hasChineseCharacters(child.description)) {
              child.description_zh = child.description
              try {
                child.description = await fanyi(child.description)
              }
              catch (error) {
                if (stack >= limit)
                  return
                stack++
                console.log('reload', newUrl)
                setTimeout(setup, 500)
                return
              }
            }
            if (!hasChineseCharacters(child.description_zh)) {
              try {
                child.description_zh = await fanyi(child.description)
              }
              catch (error) {
                if (stack >= limit)
                  return
                stack++
                console.log('reload', newUrl)
                setTimeout(setup, 500)
                return
              }
            }
          }
        }
      }
    }
    for (const key in obj.props || {}) {
      const value = obj.props[key]
      if (!value.description)
        value.description = ''

      if (!value.value)
        value.value = ''

      if (hasChineseCharacters(value.description)) {
        value.description_zh = value.description
        try {
          value.description = await fanyi(value.description)
        }
        catch (error) {
          if (stack >= limit)
            return
          stack++
          console.log('reload', newUrl)
          setTimeout(setup, 500)
          return
        }
      }
      if (!hasChineseCharacters(value.description_zh)) {
        try {
          value.description_zh = await fanyi(value.description)
        }
        catch (error) {
          if (stack >= limit)
            return
          stack++
          console.log('reload', newUrl)
          setTimeout(setup, 500)
          return
        }
      }
    }


    try {
      hasDone.add(newUrl)
      const data = JSON.stringify(obj, null, 2)
      console.log({ newUrl, resolveLength: hasDone.size, entryLength })
      if (DRY_RUN) {
        processedCount++
        console.log(`[dry-run] would write ${newUrl} (${data.length} bytes)`)
        if (REPORT_PATH)
          reportEntries.push({ file: newUrl, original: originalContent, updated: data })
      }
      else {
        await fsp.writeFile(newUrl, data)
        processedCount++
        console.log(`wrote ${newUrl}`)
        if (REPORT_PATH)
          reportEntries.push({ file: newUrl, original: originalContent, updated: data })
      }
    }
    catch (error) {
      if (stack >= limit)
        return
      stack++
      console.log('reload')
      setTimeout(setup, 500)
    }
  }))
}

if (require.main === module) {
  // CLI execution: require lib and run with parsed options
  const { runTranslate } = require('./translate-directives.lib')
  const dirIdx = process.argv.indexOf('--dir')
  const dir = dirIdx !== -1 ? process.argv[dirIdx + 1] : undefined
  const apply = process.argv.includes('--apply')
  const verbose = process.argv.includes('--verbose')
  const report = process.argv.includes('--report')
  const diff = process.argv.includes('--diff')
  const reportPathIdx = process.argv.indexOf('--report-path')
  const reportPath = reportPathIdx !== -1 && process.argv[reportPathIdx + 1] ? process.argv[reportPathIdx + 1] : undefined
  runTranslate({ dir, apply, verbose, report, diff, reportPath }).then((res) => {
    console.log(`translate-directives: processed ${res.processedCount} file(s). mode: ${apply ? 'apply' : 'dry-run'}`)
    if (report && res.report && res.report.length) {
      console.log(`Wrote report to ${path.resolve(process.cwd(), 'translate-directives-report.json')}`)
    }
    process.exit(0)
  }).catch((err) => {
    console.error('translate-directives failed', err)
    process.exit(1)
  })
}

const isTestEnv = !!(process.env.VITEST || process.env.NODE_ENV === 'test')
let warnedTranslateFailure = false
let translate
if (isTestEnv) {
  // keep the same (text, from, to) signature as the real library for safety
  translate = (text, _from, _to) => Promise.resolve({ translation: text })
}
else {
  try {
    // prefer the package export if available
    const mod = require('bing-translate-api')
    translate = mod.translate || mod
  }
  catch (err) {
    console.warn('bing-translate-api not available; translations will be a no-op')
    // keep the same (text, from, to) signature as the real library for safety
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
      // normalize translation result
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
    catch (err) {
      doReject(err)
    }
  })

  cacheMap.set(text, p)
  return p
}

function hasChineseCharacters(str) {
  const pattern = /[\u4E00-\u9FA5]/ // 匹配中文字符的正则表达式范围
  return pattern.test(str)
}
