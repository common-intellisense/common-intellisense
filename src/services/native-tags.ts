import { isHTMLTag, isSVGTag } from '@vue/shared'

/** Native platform tags must not participate in suffix-based UI component matching. */
export function isNativeTag(tag: string | undefined) {
  if (!tag)
    return false
  if (isSVGTag(tag))
    return true
  return tag === tag.toLowerCase() && isHTMLTag(tag)
}
