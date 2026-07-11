import { describe, expect, it } from 'vitest'
import { parseDeclaredDependency } from '../../src/ui/ui-find'

describe('dependency spec parsing', () => {
  it.each([
    ['^2.3.0', '2'],
    ['>=10 <12', '10'],
    ['10.x', '10'],
    ['workspace:^3.0.0', '3'],
    ['catalog:~4.2.0', '4'],
    ['npm:@scope/actual@^12.0.0', '12'],
  ])('extracts major from %s', (spec, major) => {
    expect(parseDeclaredDependency(spec).major).toBe(major)
  })

  it.each(['*', 'latest', 'next', 'workspace:*', 'file:../ui', 'link:../ui', 'patch:ui@1.0.0#x.patch', 'git+https://example.test/ui.git'])('requires the installed version for %s', (spec) => {
    expect(parseDeclaredDependency(spec).requiresInstalledVersion).toBe(true)
  })

  it('extracts npm alias package names', () => {
    expect(parseDeclaredDependency('npm:@scope/actual@^12.0.0')).toMatchObject({ packageName: '@scope/actual', major: '12' })
  })
})
