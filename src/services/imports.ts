import ts from 'typescript'

export type ImportWay = 'as default' | 'default' | 'specifier'

export interface ImportEdit {
  start: number
  end: number
  text: string
}

export function resolveImportSource(dataFrom: unknown, dynamicLib: unknown, lib: string, componentName: string, hyphenate: (name: string) => string) {
  if (typeof dataFrom === 'string' && dataFrom.trim())
    return dataFrom
  if (typeof dynamicLib === 'string' && dynamicLib.trim())
    return dynamicLib.replace('${name}', hyphenate(componentName))
  return lib
}

export function getSuggestedImportNames(suggestions: unknown, prefix: string) {
  if (!Array.isArray(suggestions) || suggestions.length !== 1)
    return []

  const suggestion = suggestions[0]
  const rawName = typeof suggestion === 'string'
    ? suggestion
    : suggestion && typeof suggestion === 'object' && 'name' in suggestion && typeof suggestion.name === 'string'
      ? suggestion.name
      : ''
  if (!rawName)
    return []

  const name = rawName.split('.')[0]
  if (name.includes('-')) {
    const withoutPrefix = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name
    return [withoutPrefix.replace(/-(\w)/g, (_: string, char: string) => char.toUpperCase())]
  }
  return [name]
}

export function createImportEdits(code: string, source: string, dependencies: string[], importWay: ImportWay = 'specifier', vue = false): ImportEdit[] {
  const names = [...new Set(dependencies.filter(name => isIdentifier(name)))]
  if (!source || !names.length)
    return []

  const script = getScriptRegion(code, vue)
  if (!script) {
    const statements = createStatements(source, names, importWay)
    return statements ? [{ start: 0, end: 0, text: `<script setup>\n${statements}\n</script>\n` }] : []
  }

  const sourceFile = ts.createSourceFile('component.tsx', script.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = sourceFile.statements.filter(ts.isImportDeclaration)
  const matching = imports.filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === source)
  const runtimeMatching = matching.filter(node => !node.importClause?.isTypeOnly)
  const existing = collectRuntimeBindings(runtimeMatching, importWay)
  const occupied = collectTopLevelBindings(sourceFile)
  const missing = names.filter(name => !existing.has(name) && !occupied.has(name))
  if (!missing.length)
    return []

  if (importWay === 'specifier') {
    const editable = runtimeMatching.find(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings))
    if (editable) {
      const clause = editable.importClause!
      const bindings = clause.namedBindings as ts.NamedImports
      const named = [
        ...bindings.elements.map(element => element.getText(sourceFile)),
        ...missing,
      ]
      const prefix = clause.name ? `${clause.name.text}, ` : ''
      const text = `import ${prefix}{ ${named.join(', ')} } from ${JSON.stringify(source)}`
      return [{ start: script.offset + editable.getStart(sourceFile), end: script.offset + editable.end, text }]
    }

    const defaultOnly = runtimeMatching.find(node => node.importClause?.name && !node.importClause.namedBindings)
    if (defaultOnly) {
      const insertion = defaultOnly.importClause!.end
      return [{ start: script.offset + insertion, end: script.offset + insertion, text: `, { ${missing.join(', ')} }` }]
    }
  }

  const statements = createStatements(source, missing, importWay)
  if (!statements)
    return []
  const lastImport = imports.at(-1)
  const insertion = lastImport ? lastImport.end : getPrologueInsertion(sourceFile, script.code)
  const beforeInsertion = script.code.slice(0, insertion)
  const leading = insertion === 0
    ? script.offset > 0 && script.code.startsWith('\n') ? '\n' : ''
    : beforeInsertion.endsWith('\n') ? '' : '\n'
  const trailing = script.code.slice(insertion).startsWith('\n') ? '' : '\n'
  return [{ start: script.offset + insertion, end: script.offset + insertion, text: `${leading}${statements}${trailing}` }]
}

function getPrologueInsertion(sourceFile: ts.SourceFile, code: string) {
  const shebangNewline = code.indexOf('\n')
  const shebangEnd = code.startsWith('#!')
    ? shebangNewline === -1 ? code.length : shebangNewline + 1
    : 0
  let insertion = shebangEnd
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))
      break
    insertion = statement.end
  }
  return insertion
}

function collectTopLevelBindings(sourceFile: ts.SourceFile) {
  const result = new Set<string>()
  const addBindingName = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      result.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element))
        addBindingName(element.name)
    }
  }
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (!clause)
        continue
      if (clause.name)
        result.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        result.add(bindings.name.text)
      }
      else if (bindings) {
        for (const element of bindings.elements)
          result.add(element.name.text)
      }
    }
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        addBindingName(declaration.name)
    }
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name) {
      result.add(statement.name.text)
    }
  }
  return result
}

function collectRuntimeBindings(imports: ts.ImportDeclaration[], importWay: ImportWay) {
  const result = new Set<string>()
  for (const node of imports) {
    const clause = node.importClause
    if (!clause)
      continue
    if (importWay === 'default' && clause.name)
      result.add(clause.name.text)
    if (importWay === 'as default' && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      result.add(clause.namedBindings.name.text)
    if (importWay === 'specifier' && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly)
          result.add(element.name.text)
      }
    }
  }
  return result
}

function createStatements(source: string, names: string[], importWay: ImportWay) {
  const quoted = JSON.stringify(source)
  if (importWay === 'default')
    return names.map(name => `import ${name} from ${quoted}`).join('\n')
  if (importWay === 'as default')
    return names.map(name => `import * as ${name} from ${quoted}`).join('\n')
  return `import { ${names.join(', ')} } from ${quoted}`
}

function getScriptRegion(code: string, vue: boolean) {
  if (!vue)
    return { code, offset: 0 }

  const matches = [...code.matchAll(/<script\b([^>]*)>/gi)]
  if (!matches.length)
    return null
  const selected = matches.find(match => /\bsetup\b/.test(match[1])) || matches[0]
  const start = selected.index! + selected[0].length
  const close = code.indexOf('</script>', start)
  const end = close === -1 ? code.length : close
  return { code: code.slice(start, end), offset: start }
}

function isIdentifier(name: string) {
  return /^[$a-z_][$\w]*$/i.test(name)
}
