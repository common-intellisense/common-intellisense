import { describe, expect, it } from 'vitest'
import { getImportDeps } from '../../src/parser'

describe('named import aliasing and components map', () => {
  it('resolves aliased imports used inside components map', () => {
    const sfc = `
<script>
import { Pagination as P } from './libs'

export default {
  components: {
    myPager: P,
  }
}
</script>
`
    const deps = getImportDeps(sfc)
    // should map local component key myPager to the import source or identifier
    expect(deps.myPager).toBe('./libs')
  })
})
