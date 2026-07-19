interface SvelteScriptRegion {
  content: string
  offset: number
}

const { parse: parseSvelte } = require('svelte/compiler')

/** Return only the component-instance script; module scripts are not template scope. */
export function getSvelteInstanceScript(code: string): SvelteScriptRegion | undefined {
  try {
    const instance = parseSvelte(code)?.instance
    const start = instance?.content?.start
    const end = instance?.content?.end
    if (typeof start === 'number' && typeof end === 'number')
      return { content: code.slice(start, end), offset: start }
  }
  catch {
    // During incomplete edits, conservatively recover only a complete non-module
    // script block. Never merge module bindings into template scope.
    for (const match of code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attributes = match[1] || ''
      if (/\bmodule\b/i.test(attributes) || /\bcontext\s*=\s*['"]module['"]/i.test(attributes))
        continue
      const full = match[0]
      const content = match[2] || ''
      const openingEnd = full.indexOf('>')
      if (openingEnd < 0)
        continue
      return { content, offset: (match.index || 0) + openingEnd + 1 }
    }
  }
}
