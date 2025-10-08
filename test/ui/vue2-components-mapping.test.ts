import { describe, expect, it } from 'vitest'
import { getImportDeps } from '../../src/parser'

describe('Vue2 components mapping in export default', () => {
  it('maps local component names to import sources', () => {
    const sfc = `
<script>
import Pagination from './Pagination.vue'
import { Other as O } from './Other.vue'

export default {
  components: {
    heihei: Pagination,
    O,
    'Quoted': O,
  }
}
</script>
<template>
  <heihei />
</template>
`

    const deps = getImportDeps(sfc)
    // imported identifiers
    expect(deps.Pagination).toBe('./Pagination.vue')
    expect(deps.O).toBe('./Other.vue')
    // component registrations should map local name -> import source
    expect(deps.heihei).toBe('./Pagination.vue')
    expect(deps.Quoted).toBe('./Other.vue')
  })
})
