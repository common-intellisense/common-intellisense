import { describe, expect, it } from 'vitest'
import { isNativeTag } from '../../src/services/native-tags'

describe('isNativeTag', () => {
  it('recognizes lowercase HTML and SVG tags', () => {
    expect(isNativeTag('button')).toBe(true)
    expect(isNativeTag('svg')).toBe(true)
  })

  it.each(['foreignObject', 'linearGradient', 'radialGradient', 'clipPath', 'textPath', 'feGaussianBlur'])('recognizes camelCase SVG intrinsic tag %s', (tag) => {
    expect(isNativeTag(tag)).toBe(true)
  })

  it.each(['Button', 'Form', 'Select', 'Table', 'Image'])('rejects PascalCase component tag %s', (tag) => {
    expect(isNativeTag(tag)).toBe(false)
  })
})
