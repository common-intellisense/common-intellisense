const fsp = require('node:fs/promises')
const path = require('path')
const process = require('process')
const data = require('./headless.data.json')

function run() {
  const link = location.href
  const basename = link.split('/').slice(-1)[0].replace(/-/g, '')
  const results = []
  Array.from(document.querySelectorAll('h3')).filter(item => item.textContent.toLowerCase().startsWith(basename) || item.textContent.toLowerCase().startsWith(basename.slice(0, -1))).map(item => {
    const name = item.textContent
    const prose = item.closest('.prose')
    const propsTable = Array.from(prose.nextElementSibling.querySelectorAll('table tr')).slice(1)
    const renderPropsTable = Array.from(prose.nextElementSibling.nextElementSibling.querySelectorAll('table tr')).slice(1)
    const props = {}
    for (const child of propsTable) {
      const [name, value, [type, description]] = Array.from(child.childNodes).map((item, i) => {
        if (i === 2) {
          const [type, description] = Array.from(item.childNodes)
          return [type.textContent, description.textContent]

        }
        return item.textContent
      })
      props[name] = {
        default: value,
        value: '',
        type,
        description,
        description_zh: description
      }
    }
    for (const child of renderPropsTable) {
      const [name, [type, description]] = Array.from(child.childNodes).map((item, i) => {
        if (i === 1) {
          const [type, description] = Array.from(item.childNodes)
          return [type.textContent, description.textContent]
        }
        return item.textContent
      })
      if (props[name])
        delete props[name]
      props[':' + name] = {
        default: '',
        value: '',
        type,
        description,
        description_zh: description
      }
    }
    console.log({ props })
    const events = []
    const methods = []
    const slots = []
    const result = { name, props, link, link_zh: link, typeDetail: {}, events, methods, slots, suggestions: [], filename: name.split('.').join('') }
    results.push(result)
  })

  copyToClipboard(JSON.stringify(results, null, 2))
  return results
}
function copyToClipboard(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, 99999); // 选中全部内容
  document.execCommand('copy');
  document.body.removeChild(textArea);
}

function getProps() {
  const props = {}
  Array.from($0.closest('tbody').children).forEach(child => {
    const name = child.children[0].textContent.replace('*', '')
    const required = child.children[0].textContent.includes('*')
    const value = child.children[1].textContent.replaceAll('\'', '')
    const type = child.children[2].querySelector('code').textContent.replaceAll('\'', '')
    const description = child.children[2].querySelector('code + div').textContent
    props[name] = {
      "default": value,
      "value": "",
      type,
      description,
      "description_zh": description
    }
    if (required)
      props[name].required = true
  })
  console.log({ props })
  return props
}

function getEvent() {
  const events = []
  Array.from($0.closest('tbody').children).forEach(child => {
    const name = child.children[0].textContent.replace(/^update:/, '')
    const params = child.children[1].querySelector('code').textContent.replaceAll('\'', '')
    const description = child.children[1].querySelector('code + div').textContent
    events.push({ name, description, description_zh: description, params })
  })
  console.log({ events })
  return events
}

function getSlots() {
  const slots = []
  Array.from($0.closest('tbody').children).forEach(child => {
    const name = child.children[0].textContent
    const params = child.children[1].querySelector('code').textContent.replaceAll('\'', '')
    const description = `payload: ${params}\n` + child.children[1].querySelector('code + div').textContent
    slots.push({
      name,
      description,
      description_zh: description,
    })
  })
  console.log({ slots })
  return slots
}

function getMethods() {
  const methods = []
  Array.from($0.closest('tbody').children).forEach(child => {
    const name = child.children[0].textContent.replace(/^update:/, '')
    const params = child.children[1].querySelector('code').textContent.replaceAll('\'', '')
    const description = child.children[1].querySelector('code + div').textContent
    methods.push({
      name,
      description,
      params,
      description_zh: description
    })
  })
  console.log({ methods })
  return methods
}


const cwd = process.cwd()
function arrayGenerateFile(array) {
  const baseSrc = 'src/ui/headlessReact/headlessReact2'
  array.forEach(async item => {
    const url = path.resolve(cwd, baseSrc, `${item.filename}.json`)
    // 兼容 suggestions
    try {
      const fileContent = JSON.parse(await fsp.readFile(url, 'utf-8'))
      const suggestions = fileContent.suggestions || []
      item.suggestions = suggestions
    } catch (e) {

    }

    fsp.writeFile(url, JSON.stringify(item, null, 2), 'utf-8')
  })
}


arrayGenerateFile(data)
