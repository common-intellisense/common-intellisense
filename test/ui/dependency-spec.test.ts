import { describe, expect, it } from 'vitest'
import { collectDependencyScopes, getDependencyResolveFrom, parseDeclaredDependency, selectDependencyVersion } from '../../src/ui/ui-find'

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

  it.each([
    ['>=10 <12', '11.2.0', '11.2.0'],
    ['>=4 <6', '5.1.0', '5.1.0'],
    ['2 || 3', '3.4.0', '3.4.0'],
    ['>=2', '8.0.0', '8.0.0'],
    ['>=10 <12', '12.0.0', '10'],
  ])('selects installed %s versions using semver semantics', (range, installed, expected) => {
    const parsed = parseDeclaredDependency(range)
    expect(selectDependencyVersion(installed, parsed.major, parsed.range)).toBe(expected)
  })

  it('applies semver ranges to npm aliases', () => {
    const parsed = parseDeclaredDependency('npm:@scope/actual@>=10 <12')
    expect(parsed.packageName).toBe('@scope/actual')
    expect(selectDependencyVersion('11.2.0', parsed.major, parsed.range)).toBe('11.2.0')
  })

  it.each(['devDependencies', 'peerDependencies', 'optionalDependencies'])('lets local %s override root dependencies', (field) => {
    const scopes = collectDependencyScopes({ [field]: { 'element-plus': '^1.0.0' } }, {
      dependencies: { 'element-plus': '^2.0.0' },
    })

    expect(scopes.dependencies['element-plus']).toBe('^1.0.0')
    expect('element-plus' in scopes.localDependencies).toBe(true)
    expect(getDependencyResolveFrom('element-plus', scopes.localDependencies, '/workspace/packages/a', '/workspace')).toBe('/workspace/packages/a')
  })
})
