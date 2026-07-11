// @ts-expect-error browser build avoids optional Node template-engine dependencies
import { parse as parseVueSfc } from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
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

  if (importWay === 'default' || importWay === 'as default') {
    const promotion = findTypeOnlyValuePromotion(matching, names, importWay)
    if (promotion) {
      const promotedName = importWay === 'default'
        ? promotion.clause.name!.text
        : (promotion.clause.namedBindings as ts.NamespaceImport).name.text
      const additional = names.filter(name => name !== promotedName && !existing.has(name) && !occupied.has(name))
      const sourceText = JSON.stringify(source)
      const preserved: string[] = []
      if (importWay === 'default') {
        const bindings = promotion.clause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          const named = bindings.elements.map(element => `type ${getImportSpecifierText(element)}`)
          preserved.push(`import ${promotedName}, { ${named.join(', ')} } from ${sourceText}`)
        }
        else {
          preserved.push(`import ${promotedName} from ${sourceText}`)
          if (bindings && ts.isNamespaceImport(bindings))
            preserved.push(`import type * as ${bindings.name.text} from ${sourceText}`)
        }
      }
      else {
        if (promotion.clause.name)
          preserved.push(`import type ${promotion.clause.name.text} from ${sourceText}`)
        preserved.push(`import * as ${promotedName} from ${sourceText}`)
      }
      const extraStatements = createStatements(source, additional, importWay)
      if (extraStatements)
        preserved.push(extraStatements)
      return [{
        start: script.offset + promotion.declaration.getStart(sourceFile),
        end: script.offset + promotion.declaration.end,
        text: preserved.join('\n'),
      }]
    }
  }

  if (importWay === 'specifier') {
    const promotion = findTypeOnlyPromotion(matching, names.filter(name => !existing.has(name)))
    if (promotion) {
      const promoted = new Set(promotion.elements.map(element => element.name.text).filter(name => names.includes(name)))
      const additional = names.filter(name => !promoted.has(name) && !existing.has(name) && !occupied.has(name))
      const named = promotion.elements.map((element) => {
        const text = getImportSpecifierText(element)
        const isTypeOnly = promotion.declaration.importClause?.isTypeOnly || element.isTypeOnly
        return isTypeOnly && !promoted.has(element.name.text) ? `type ${text}` : text
      })
      named.push(...additional)
      const clause = promotion.declaration.importClause!
      const prefix = !clause.isTypeOnly && clause.name ? `${clause.name.text}, ` : ''
      const preservedTypeDefault = clause.isTypeOnly && clause.name ? `import type ${clause.name.text} from ${JSON.stringify(source)}\n` : ''
      const text = `${preservedTypeDefault}import ${prefix}{ ${named.join(', ')} } from ${JSON.stringify(source)}`
      return [{ start: script.offset + promotion.declaration.getStart(sourceFile), end: script.offset + promotion.declaration.end, text }]
    }
  }

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

function findTypeOnlyValuePromotion(imports: ts.ImportDeclaration[], names: string[], importWay: Exclude<ImportWay, 'specifier'>) {
  const requested = new Set(names)
  for (const declaration of imports) {
    const clause = declaration.importClause
    if (!clause?.isTypeOnly)
      continue
    if (importWay === 'default' && clause.name && requested.has(clause.name.text))
      return { declaration, clause }
    if (importWay === 'as default' && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && requested.has(clause.namedBindings.name.text))
      return { declaration, clause }
  }
}

function findTypeOnlyPromotion(imports: ts.ImportDeclaration[], names: string[]) {
  const requested = new Set(names)
  for (const declaration of imports) {
    const clause = declaration.importClause
    const bindings = clause?.namedBindings
    if (!clause || !bindings || !ts.isNamedImports(bindings))
      continue
    const promotable = bindings.elements.some(element => requested.has(element.name.text) && (clause.isTypeOnly || element.isTypeOnly))
    if (promotable)
      return { declaration, elements: [...bindings.elements] }
  }
}

function getImportSpecifierText(element: ts.ImportSpecifier) {
  return element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text
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

  const { descriptor } = parseVueSfc(code)
  const selected = descriptor.scriptSetup?.src
    ? descriptor.script && !descriptor.script.src ? descriptor.script : undefined
    : descriptor.scriptSetup || (descriptor.script && !descriptor.script.src ? descriptor.script : undefined)
  if (!selected)
    return null
  return { code: selected.content, offset: selected.loc.start.offset }
}

function isIdentifier(name: string) {
  return /^[$a-z_][$\w]*$/i.test(name)
}
