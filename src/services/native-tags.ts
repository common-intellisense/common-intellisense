import { isHTMLTag, isSVGTag } from '@vue/shared'

/** Native platform tags must not participate in suffix-based UI component matching. */
export function isNativeTag(tag: string | undefined) {
  if (!tag)
    return false
  if (tag !== tag.toLowerCase())
    return false
  return isHTMLTag(tag) || isSVGTag(tag)
}
