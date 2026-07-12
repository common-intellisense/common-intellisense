import { isHTMLTag, isSVGTag } from '@vue/shared'

/** Native platform tags must not participate in suffix-based UI component matching. */
export function isNativeTag(tag: string | undefined) {
  if (!tag)
    return false
  const normalized = tag.toLowerCase()
  return isHTMLTag(normalized) || isSVGTag(normalized)
}
