import fsp from 'node:fs/promises'
import data from './data.json'

function transform(componentName: string) {
  try {
    const obj = data[componentName.toLowerCase()].interfaces.values
    const _props = obj[`${componentName}Props`]?.props || []
    const _events = obj[`${componentName}Emits`]?.methods || []
    const _slots = obj[`${componentName}Slots`]?.methods || []
    const props: any = {}
    const events: any = []
    const slots: any[] = []
    _props.forEach((p: any) => {
      const { name, type, default: _default, description } = p
      props[name] = {
        default: _default,
        description,
        description_zh: description,
        type,
        value: '',
        required: false,
      }
    })
    _events.forEach((e: any) => {
      const { name, parameters, description, returnType } = e
      events.push({
        name,
        description,
        description_zh: description,
        params: parameters.length
          ? `(${parameters.map((item) => {
            return `${item.name}${item.optional ? '?' : ''}: ${item.type}`
          }).join(', ')}) => ${returnType}`
          : `() => ${returnType}`,
      })
    })
    _slots.forEach((s: any) => {
      const { name, description, parameters } = s
      slots.push({
        name,
        params: parameters.map((item: any) => item.type).join('\n'),
        description,
      })
    })
    return {
      name: componentName,
      props,
      events,
      slots,
      suggestions: [],
      link: `https://primevue.org/${componentName.toLowerCase()}/`,
    }
  }
  catch (error) {
    console.log(componentName, error)
  }
}

const list: string[] = []
for (const key in data) {
  const value = data[key]
  if (value.components) {
    let name = value.components.default.description.split(' ')[0]
    if (name.toLowerCase() !== key) {
      if (value?.interfaces.values) {
        for (const k in value.interfaces.values) {
          if (k.toLowerCase() === `${key}props`) {
            name = k.split('Props')[0]
            break
          }
        }
      } else
        name = key[0].toLocaleUpperCase() + key.slice(1)
    }
    list.push(name)
  }
}

const base = process.cwd()
const primevue3ComponentsMap: string[][] = []
const primevue3Map: string[] = []
const primevue3Importers: string[] = []

function run() {
  list.forEach((name: string) => fsp.writeFile(`${base}/src/ui/primevue/primevue4/${name}.json`, JSON.stringify(transform(name), null, 2)))
  list.forEach((name) => {
    primevue3Importers.push(`import ${name} from './${name}.json'`)
    primevue3Map.push(name)
    primevue3ComponentsMap.push([name, name, `<${name}></${name}>`])
  })
  // generateIndex()
  console.log('primevue generate done!')
}

function generateIndex() {
  const indexTemplate = `import { componentsReducer, propsReducer } from '../../utils'
  ${primevue3Importers.join('\n')}
  
export function primevue3() {
  const map: any = ${JSON.stringify(primevue3Map, null, 4).replace(/"/g, '')}

  return propsReducer(map)
}
  
export function primevue3Components() {
  const map = ${JSON.stringify(primevue3ComponentsMap, null, 4)}
  return componentsReducer(map)
}
  `
  fsp.writeFile(`${base}/src/ui/primevue/primevue3/index.ts`, indexTemplate)
}

run()

// export default run
