import packageJson from '../package.json'
import { describe, expect, it } from 'vitest'

function acceptsString(items: any, value: string) {
  return items.anyOf?.some((option: any) => option.type === 'string' || option.enum?.includes(value)) === true
}

describe('package configuration schema', () => {
  it('accepts both legacy arrays and package-scoped object values', () => {
    const schema = (packageJson as any).contributes.configuration.properties['common-intellisense.ui']
    const [legacyArray, scopedObject] = schema.oneOf

    expect(legacyArray).toMatchObject({ type: 'array' })
    expect(scopedObject).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'array' },
    })
    expect(legacyArray.items).toBeDefined()
    expect(scopedObject.additionalProperties.items).toEqual(legacyArray.items)
  })

  it('recommends canonical UI names while accepting alias-derived selections', () => {
    const schema = (packageJson as any).contributes.configuration.properties['common-intellisense.ui']
    const arrayItems = schema.oneOf[0].items
    const scopedItems = schema.oneOf[1].additionalProperties.items

    for (const items of [arrayItems, scopedItems]) {
      expect(items.anyOf).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'string' })]))
      const recommended = items.anyOf.find((option: any) => option.enum)?.enum
      expect(recommended).toEqual(expect.arrayContaining([
        'nextUi2',
        'nuxtUi2',
        'nuxtUiPro1',
        'arkVue4',
        'dcloudioUniUi1',
        'uviewPlus3',
      ]))
      expect(acceptsString(items, 'my-ui5')).toBe(true)
    }
  })
})
