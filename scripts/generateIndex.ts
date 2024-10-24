const root = process.cwd()
const path = require('node:path')
const fsp = require('node:fs/promises')
const fg = require('fast-glob')

export async function run() {
  const folder = 'src/ui'
  const lib = 'xxxi'
  const name = 'xx1'
  const isReact = false
  const isHyphen = !isReact  /** 生成的模板中的使用是 true ? a-affix : AAfix */
  const url = path.resolve(root, `${folder}/${name}`)
  const entry = await fg(['**/*.json'], { dot: true, cwd: url })
  const imports = entry.map((_url: string) => `import ${_url.split('.')[0]} from './${_url}'`)
  let prefix = 'wd'
  const map = entry.map((_url: string) => {
    let tagName = `${_url.split('.')[0]}`
    if (isHyphen) {
      // prefix = `'${tagName.split('-')[0]}'`
      return `[${_url.split('.')[0]}, ${_url.split('.')[0]}.name, \`<\${hyphenate(${tagName}.name)}></\${hyphenate(${tagName}.name)}>\`],`

    }
    return `[${_url.split('.')[0]}, ${_url.split('.')[0]}.name, \`<\${${tagName}.name}></\${${tagName}.name}\`],`
  })
  const template
    = `import { getComponentsMap, getPropsMap } from './mapping'
// import directives from '../directives.json'

export function ${name}() {
  return {
    uiName: '${lib}',
    lib: '${lib}',
    map: getPropsMap(),
  }
}

export function ${name}Components() {
  return {
    map: getComponentsMap(),
    isSeperatorByHyphen: ${isHyphen},
    prefix: '${prefix}',
    isReact: ${isReact},
    lib: '${lib}',
    // directives: directives.${name},
  }
}
`
  // 生成 index.ts
  fsp.writeFile(path.resolve(root, `${folder}/${name}/index.ts`), template)
  // 生成 mapping.ts
  fsp.writeFile(path.resolve(root, `${folder}/${name}/mapping.ts`), `${imports.join('\n')}

export function getPropsMap() {
  return [
    ${entry.map((_url: string) => `${_url.split('.')[0]},`).join('\n    ')}
  ]
}

export function getComponentsMap() {
  return [
    ${map.join('\n    ')}
  ]
}${isHyphen ? '\nexport function hyphenate(s: string): string {\n  return s.replace(/([A-Z])/g, \'-$1\').toLowerCase().replace(/^-/, \'\')\n}' : ''}`)
}

run()

function hyphenate(s: string): string {
  return s.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')
}
