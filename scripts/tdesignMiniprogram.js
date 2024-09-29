import data from './tdesignMiniprogram.data.json'
import path from 'path'
import fsp from 'node:fs/promises'

function run() {
  const link = location.href
  let linkName = link.split('/').slice(-1)[0].split('.')[0]
  linkName = linkName[0].toUpperCase() + linkName.slice(1)
  const r = {}
  Array.from(document.querySelectorAll('[name="API"]>h3')).forEach(item => {
    if (item.id.endsWith('props')) {
      let _name = item.textContent.split(' ')[0]
      if (_name.toLocaleLowerCase() === 'props')
        _name = linkName.replace('en-US', 'zh-CN')
      console.log('props:', _name)
      const target = r[_name] || (r[_name] = {})
      const props = target.props || (target.props = {})
      Array.from(item.nextElementSibling.querySelectorAll('tbody tr')).forEach((item) => {
        const name = item.children[0].textContent.split(' ')[0]
        const version = item.children[0].textContent.split(' ').slice(1).join((' '))
        const required = item.children[4].textContent.trim() === 'Y'
        const type = item.children[1].textContent
        const value = item.children[2].textContent
        const description = item.children[3].textContent
        props[name] = {
          description,
          description_zh: description,
          default: value,
          value: '',
          type,
          required,
          version
        }
      })
    } else if (item.id.endsWith('events')) {
      let _name = item.textContent.split(' ')[0]
      if (_name.toLocaleLowerCase() === 'event')
        _name = linkName.replace('en-US', 'zh-CN')

      const target = r[_name] || (r[_name] = {})
      const props = target.props || (target.props = {})
      Array.from(item.nextElementSibling.querySelectorAll('tbody tr')).forEach((item) => {
        const name = 'bind' + item.children[0].textContent.split(' ')[0]
        const type = item.children[1].textContent
        const description = item.children[2].textContent
        props[name] = {
          description,
          description_zh: description,
          default: '',
          value: '',
          type,
        }
      })
    } else if (item.id.endsWith('slot')) {
      let _name = item.textContent.split(' ')[0]
      if (_name.toLocaleLowerCase() === 'slot')
        _name = linkName.replace('en-US', 'zh-CN')
      console.log('slot:', _name)
      const target = r[_name] || (r[_name] = {})
      const slots = target.slots || (target.slots = [])
      Array.from(item.nextElementSibling.querySelectorAll('tbody tr')).forEach((item) => {
        let name = item.children[0].textContent.split(' ')[0]
        const description = item.children[1].textContent
        if (name === '-' || !name)
          name = 'default'
        slots.push({
          name,
          description,
          description_zh: description,
        })
      })
    } else if (item.id.endsWith('slots')) {
      let _name = item.textContent.split(' ')[0]
      if (_name.toLocaleLowerCase() === 'slots')
        _name = linkName.replace('en-US', 'zh-CN')
      console.log('slots:', _name)
      const target = r[_name] || (r[_name] = {})
      const slots = target.slots || (target.slots = [])
      Array.from(item.nextElementSibling.querySelectorAll('tbody tr')).forEach((item) => {
        let name = item.children[0].textContent.split(' ')[0]
        const description = item.children[1].textContent
        if (name === '-' || !name)
          name = 'default'
        slots.push({
          name,
          description,
          description_zh: description,
        })
      })
    }
    else if (item.id.endsWith('methods')) {
      let _name = item.textContent.split(' ')[0]
      if (_name === 'methods')
        _name = linkName.replace('en-US', 'zh-CN')
      console.log('methods:', _name)
      const target = r[_name] || (r[_name] = {})
      const methods = target.methods || (target.methods = [])
      Array.from(item.nextElementSibling.querySelectorAll('tbody tr')).forEach((item) => {
        const name = item.children[0].textContent.split('(')[0]
        const description = item.children[1].textContent
        const params = item.children[0].textContent.split('(')[1]
          ? `(${item.children[0].textContent.split('(')[1]}`
          : ''
        methods.push({ name, description, description_zh: description, params })
      })
    }
    else if (item.textContent.endsWith('方法')) {
      let _name = item.textContent.split(' ')[0]
      if (_name === '方法')
        _name = linkName.replace('en-US', 'zh-CN')
      console.log('方法:', _name)
      const target = r[_name] || (r[_name] = {})
      const methods = target.methods || (target.methods = [])
      Array.from(item.nextElementSibling.querySelectorAll('tbody tr')).forEach((item) => {
        const name = item.children[0].textContent.split('(')[0]
        const description = item.children[1].textContent
        const params = item.children[0].textContent.split('(')[1]
          ? `(${item.children[0].textContent.split('(')[1]}`
          : ''
        methods.push({ name, description, description_zh: description, params })
      })
    }
  })
  const results = []
  for (const key in r) {
    const baseName = key.split('/').slice(-1)[0].split('.')[0].split('-').map((i) => {
      return i[0].toUpperCase() + i.slice(1)
    }).join('')
    const name = `T${baseName}`
    const result = { name, props: r[key].props, link, link_zh: link, typeDetail: {}, events: r[key].events || [], methods: r[key].methods || [], slots: r[key].slots || [], suggestions: [], filename: baseName }
    console.log({ result })
    results.push(result)
  }
  copyToClipboard(JSON.stringify(results, null, 2))
}

function getprops() {
  const props = {}
  $0.closest('tbody').querySelectorAll('tr').forEach((item) => {
    const name = item.children[0].textContent.split(' ')[0]
    const description = item.children[1].textContent
    const type = item.children[2].textContent
    const value = item.children[3].textContent
    props[name] = {
      description,
      description_zh: description,
      default: value,
      value: '',
      type,
    }
  })
  return props
}

function getSlots() {
  const slots = []
  const slotBody = $0.closest('tbody').querySelectorAll('tr')
  if (slotBody) {
    Array.from(slotBody).forEach((item) => {
      let name = item.children[0].textContent.split(' ')[0]
      const description = item.children[1].textContent
      if (name === '-' || !name)
        name = 'default'
      slots.push({
        name,
        description,
        description_zh: description,
      })
    })
  }
  return slots
}

function getmethods() {
  const methods = []
  const methodsBody = $0.closest('tbody').querySelectorAll('tr')
  if (methodsBody) {
    Array.from(methodsBody).forEach((item) => {
      const name = item.children[0].textContent.split('(')[0]
      const description = item.children[1].textContent
      const params = item.children[0].textContent.split('(')[1]
        ? `(${item.children[0].textContent.split('(')[1]}`
        : ''
      methods.push({ name, description, description_zh: description, params })
    })
  }
  return methods
}

function getevents() {
  const events = []
  const eventBody = $0.closest('tbody').querySelectorAll('tr')
  if (eventBody) {
    Array.from(eventBody).forEach((item) => {
      const name = item.children[0].textContent
      const description = item.children[1].textContent
      const params = item.children[2].textContent
      events.push({ name, description, description_zh: description, params })
    })
  }
  return events
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
  const baseSrc = 'src/ui/tdesignMiniprogram/tdesignMiniprogram1'
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
