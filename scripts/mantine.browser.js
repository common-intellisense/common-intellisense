const fsp = require('node:fs/promises')
const path = require('path')
const process = require('process')
const data = require('./mantine.data.json')

function run() {
  const link = location.href
  const results = []
  Array.from(document.querySelectorAll('h2')).filter(item => /(events|attributes)/.test(item.textContent.toLowerCase())).map(item => {
    const name = item.textContent.split(' ')[0]
    const type = item.textContent.split(' ').slice(-1)[0].toLowerCase()
    let propsTable = []
    if (type === 'props')
      propsTable = item.nextElementSibling.querySelectorAll('table tbody tr')
    else if (type === 'events') {

    }
    else if (type === 'slots') {

    }
    const props = {}
    const events = []
    const slots = []
    const methods = []
    for (const child of propsTable) {
      const [name, type, description] = Array.from(child.childNodes).map((item, i) => item.textContent)
      props[name] = {
        default: '',
        value: '',
        type,
        description,
        required: false,
        description_zh: description
      }
    }

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

const cwd = process.cwd()
function arrayGenerateFile(array) {
  const baseSrc = 'src/ui/mantineCharts7'
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
