const fsp = require('node:fs/promises')
const path = require('path')
const process = require('process')
const data = require('./wotDesignUni.data.json')

function run() {
  const link = location.href
  const results = []
  const compName = document.querySelector('h1').textContent.split(' ')[0]
  Array.from(document.querySelectorAll('h2')).filter(item => /(events|attributes|slot|methods)/.test(item.textContent.toLowerCase())).map(item => {
    let [name, type] = item.firstChild.textContent.split(' ').map(trim => trim.replace(/[\s\n]/g,''))
    let propsTable = []
    let eventsTable = []
    let slotsTable = []
    let methodsTable = []
    if (!type) {
      if (name === 'Attributes') {
        type = 'Attributes'
        name = `Wd${compName}`
      } else if (name === 'Events') {
        type = 'Events'
        name = `Wd${compName}`
      }else if(name==='Slot' || name==='Slots'){
        type = 'Slot'
        name = `Wd${compName}`
      }else if(name ==='Methods' || name ==='Method'){
        type = 'Methods'
        name = `Wd${compName}`
      }
    }else {
      name = `Wd${name}`
    }
    if (type === 'Attributes')
      propsTable = item.nextElementSibling.querySelectorAll('table tbody tr')
    else if (type === 'Events') {
      eventsTable = item.nextElementSibling.querySelectorAll('table tbody tr')
    }
    else if (type === 'Slot') {
      slotsTable = item.nextElementSibling.querySelectorAll('table tbody tr')
    }
    else if(type === 'Methods'){
       methodsTable = item.nextElementSibling.querySelectorAll('table tbody tr')
    }
    const props = {}
    const events = []
    const slots = []
    const methods = []
    for (const child of propsTable) {
      const [name, description, type, optional, value, version] = Array.from(child.childNodes).map((item, i) => item.textContent)
      props[name] = {
        default: '',
        value,
        type: (optional === '-' || !optional) ? type : optional,
        description,
        version,
        required: false,
        description_zh: description
      }
    }
    for (const child of eventsTable) {
      const [name, description, params, version] = Array.from(child.childNodes).map((item, i) => item.textContent)
      events.push({
        name,
        description,
        params,
        version
      })
    }
    for(const child of slotsTable){
      const [name, description, version] = Array.from(child.childNodes).map((item, i) => item.textContent)
      slots.push({
        name,
        description,
        version
      })
    }
    for(const child of methodsTable){
      const [name, description, params, version] = Array.from(child.childNodes).map((item, i) => item.textContent)
      methods.push({
        name,
        description,
        params,
        version
      })
    }
    const target = results.find(item=>item.name===name)
    if(target){
      // 合并
      target.props = {...target.props, ...props}
      target.events = [...target.events, ...events]
      target.slots = [...target.slots, ...slots]
      target.methods = [...target.methods, ...methods]
      return
    }
    const result = { name, props, link, link_zh: link, typeDetail: {}, events, methods, slots, suggestions: [], filename: name.slice(2).split('.').join('') }
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
  const baseSrc = 'src/ui/wotDesignUni1'
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
