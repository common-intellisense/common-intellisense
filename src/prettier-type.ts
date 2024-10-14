import * as ts from 'typescript'

export function prettierType(typeString: string) {
  const sourceFile = ts.createSourceFile('temp.ts', typeString, ts.ScriptTarget.Latest)
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const formatted = printer.printNode(ts.EmitHint.Unspecified, sourceFile, sourceFile)
  return formatted
}
