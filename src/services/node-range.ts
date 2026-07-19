export interface NodeOffsetRange {
  start: number
  end: number
}

/** Resolve parser nodes to absolute document offsets. */
export function getNodeOffsetRange(node: any, blockOffset = 0): NodeOffsetRange | undefined {
  if (Array.isArray(node?.range)
    && Number.isInteger(node.range[0])
    && Number.isInteger(node.range[1])) {
    return {
      start: node.range[0] + blockOffset,
      end: node.range[1] + blockOffset,
    }
  }

  const start = node?.loc?.start?.offset
  const end = node?.loc?.end?.offset
  if (Number.isInteger(start) && Number.isInteger(end)) {
    return {
      start: start + blockOffset,
      end: end + blockOffset,
    }
  }
}
