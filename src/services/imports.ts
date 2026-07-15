// @ts-expect-error browser build avoids optional Node template-engine dependencies
import { parse as parseVueSfc } from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
import ts from 'typescript'
import { getSvelteInstanceScript } from './svelte-script'

export type ImportWay = 'as default' | 'default' | 'specifier'
export type ImportHost = 'script' | 'vue' | 'svelte'

export interface ImportEdit {
  start: number
  end: number
  text: string
}

export interface ImportDocumentContext {
  languageId?: string
  uri?: string
  preferredOffset?: number
  preferredVueBlock?: 'script' | 'scriptSetup'
  expectedBlockLang?: string
  registerVueComponent?: boolean
}

interface ScriptRegion {
  code: string
  offset: number
  scriptKind: ts.ScriptKind
  fileName: string
  vueMode?: 'setup' | 'normal'
}

export function resolveImportSource(dataFrom: unknown, dynamicLib: unknown, lib: string, componentName: string, hyphenate: (name: string) => string) {
  if (typeof dataFrom === 'string' && dataFrom.trim())
    return dataFrom
  if (typeof dynamicLib === 'string' && dynamicLib.trim())
    return dynamicLib.replace('${name}', hyphenate(componentName))
  return lib
}

export function getSuggestedImportNames(suggestions: unknown, prefix: string, importWay: ImportWay = 'specifier') {
  // A default or namespace import represents one module value. Suggestions may
  // resolve through a per-component dynamic source, so importing them from the
  // selected component's source would bind every name to the same export.
  if (importWay !== 'specifier' || !Array.isArray(suggestions) || suggestions.length !== 1)
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

export function createImportEdits(code: string, source: string, dependencies: string[], importWay: ImportWay = 'specifier', hostOrVue: ImportHost | boolean = 'script', context: ImportDocumentContext = {}): ImportEdit[] {
  const host: ImportHost = typeof hostOrVue === 'boolean' ? (hostOrVue ? 'vue' : 'script') : hostOrVue
  const names = [...new Set(dependencies.filter(name => isSafeBindingIdentifier(name)))]
  if (!source || !names.length)
    return []

  const script = getScriptRegion(code, host, context)
  if (!script) {
    if (host === 'vue' && context.preferredVueBlock)
      return []
    const statements = createStatements(source, names, importWay)
    if (!statements)
      return []
    if (host === 'vue') {
      if (!canCreateVueScript(code))
        return []
      return [{ start: 0, end: 0, text: `<script>\n${statements}\nexport default { components: { ${names.join(', ')} } }\n</script>\n` }]
    }
    if (host === 'svelte')
      return [{ start: 0, end: 0, text: `<script>\n${statements}\n</script>\n` }]
    return [{ start: 0, end: 0, text: `${statements}\n` }]
  }

  const sourceFile = ts.createSourceFile(script.fileName, script.code, ts.ScriptTarget.Latest, true, script.scriptKind)
  const imports = sourceFile.statements.filter(ts.isImportDeclaration)
  const matching = imports.filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === source)
  const runtimeMatching = matching.filter(node => !node.importClause?.isTypeOnly)
  const existing = collectRuntimeBindings(runtimeMatching, importWay)
  const occupied = collectTopLevelBindings(sourceFile)
  const finish = (edits: ImportEdit[], runtimeNames: string[]) => {
    const registeredNames = names.filter(name => runtimeNames.includes(name))
    if (!registeredNames.length)
      return []
    if (script.vueMode !== 'normal' || context.registerVueComponent === false)
      return edits
    const registration = getVueRegistrationEdits(sourceFile, script, registeredNames)
    return registration ? [...edits, ...registration] : []
  }

  if (importWay === 'default' || importWay === 'as default') {
    const promotion = findTypeOnlyValuePromotion(matching, names, importWay)
    if (promotion) {
      const promotedName = importWay === 'default'
        ? promotion.clause.name!.text
        : (promotion.clause.namedBindings as ts.NamespaceImport).name.text
      if (collectRuntimeBindingConflicts(sourceFile, promotion.declaration, importWay === 'default').has(promotedName))
        return []
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
      return finish([{
        start: script.offset + promotion.declaration.getStart(sourceFile),
        end: script.offset + promotion.declaration.end,
        text: preserved.join('\n'),
      }], [...existing, promotedName, ...additional])
    }
  }

  if (importWay === 'specifier') {
    const conflicts = collectSpecifierConflicts(sourceFile, new Set(matching))
    const requested = names.filter(name => !existing.has(name) && !conflicts.has(name))
    const promotions = findTypeOnlyPromotions(matching, requested)
    if (promotions.length) {
      const promoted = new Set(promotions.flatMap(promotion => promotion.promotedNames))
      const additional = requested.filter(name => !promoted.has(name))
      const edits = promotions.map((promotion, index) => {
        const named = promotion.elements.map((element) => {
          const text = getImportSpecifierText(element)
          const isTypeOnly = promotion.declaration.importClause?.isTypeOnly || element.isTypeOnly
          return isTypeOnly && !promotion.promotedNames.includes(element.name.text) ? `type ${text}` : text
        })
        if (index === 0)
          named.push(...additional)
        const clause = promotion.declaration.importClause!
        const prefix = !clause.isTypeOnly && clause.name ? `${clause.name.text}, ` : ''
        const preservedTypeDefault = clause.isTypeOnly && clause.name ? `import type ${clause.name.text} from ${JSON.stringify(source)}\n` : ''
        const text = `${preservedTypeDefault}import ${prefix}{ ${named.join(', ')} } from ${JSON.stringify(source)}`
        return { start: script.offset + promotion.declaration.getStart(sourceFile), end: script.offset + promotion.declaration.end, text }
      })
      return finish(edits, [...existing, ...promoted, ...additional])
    }
  }

  const missing = names.filter(name => !existing.has(name) && !occupied.has(name))
  if (!missing.length)
    return finish([], [...existing])

  if (importWay === 'specifier') {
    const editable = runtimeMatching.find(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings))
    if (editable) {
      const bindings = editable.importClause!.namedBindings as ts.NamedImports
      const bindingStart = bindings.getStart(sourceFile)
      const bindingText = script.code.slice(bindingStart, bindings.end)
      const multiline = bindingText.includes('\n')
      if (multiline) {
        const closingBrace = bindings.end - 1
        const closingLineStart = script.code.lastIndexOf('\n', closingBrace - 1) + 1
        const last = bindings.elements.at(-1)
        const indentation = last
          ? script.code.slice(script.code.lastIndexOf('\n', last.getStart(sourceFile) - 1) + 1, last.getStart(sourceFile)).match(/^\s*/)?.[0] || '  '
          : `${script.code.slice(closingLineStart, closingBrace)}  `
        const edits: ImportEdit[] = [{
          start: script.offset + closingLineStart,
          end: script.offset + closingLineStart,
          text: `${indentation}${missing.join(`,\n${indentation}`)},\n`,
        }]
        // Insert the comma immediately after the last specifier so a trailing line
        // comment remains attached to that specifier instead of the new binding.
        if (last && !bindings.elements.hasTrailingComma) {
          edits.push({
            start: script.offset + last.end,
            end: script.offset + last.end,
            text: ',',
          })
        }
        return finish(edits, [...existing, ...missing])
      }
      let insertion = bindings.end - 1
      while (insertion > bindingStart && /\s/.test(script.code[insertion - 1]))
        insertion--
      const prefix = bindings.elements.length === 0 ? ' ' : bindings.elements.hasTrailingComma ? ' ' : ', '
      const suffix = bindings.elements.length === 0 ? ' ' : ''
      return finish([{ start: script.offset + insertion, end: script.offset + insertion, text: `${prefix}${missing.join(', ')}${suffix}` }], [...existing, ...missing])
    }

    const defaultOnly = runtimeMatching.find(node => node.importClause?.name && !node.importClause.namedBindings)
    if (defaultOnly) {
      const insertion = defaultOnly.importClause!.end
      return finish([{ start: script.offset + insertion, end: script.offset + insertion, text: `, { ${missing.join(', ')} }` }], [...existing, ...missing])
    }
  }

  const statements = createStatements(source, missing, importWay)
  if (!statements)
    return finish([], [...existing])
  const lastImport = imports.at(-1)
  const insertion = lastImport ? lastImport.end : getPrologueInsertion(sourceFile, script.code)
  const beforeInsertion = script.code.slice(0, insertion)
  const leading = insertion === 0
    ? host === 'svelte' || (script.offset > 0 && script.code.startsWith('\n')) ? '\n' : ''
    : beforeInsertion.endsWith('\n') ? '' : '\n'
  const trailing = script.code.slice(insertion).startsWith('\n') ? '' : '\n'
  return finish([{ start: script.offset + insertion, end: script.offset + insertion, text: `${leading}${statements}${trailing}` }], [...existing, ...missing])
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

function findTypeOnlyPromotions(imports: ts.ImportDeclaration[], names: string[]) {
  const requested = new Set(names)
  const promotions: Array<{ declaration: ts.ImportDeclaration, elements: ts.ImportSpecifier[], promotedNames: string[] }> = []
  for (const declaration of imports) {
    const clause = declaration.importClause
    const bindings = clause?.namedBindings
    if (!clause || !bindings || !ts.isNamedImports(bindings))
      continue
    const promotedNames = bindings.elements
      .filter(element => requested.has(element.name.text) && (clause.isTypeOnly || element.isTypeOnly))
      .map(element => element.name.text)
    if (promotedNames.length)
      promotions.push({ declaration, elements: [...bindings.elements], promotedNames })
  }
  return promotions
}

function collectRuntimeBindingConflicts(sourceFile: ts.SourceFile, ignoredImport: ts.ImportDeclaration, allowNamespaceMerge: boolean) {
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
      if (statement === ignoredImport || statement.importClause?.isTypeOnly)
        continue
      const clause = statement.importClause
      if (clause?.name)
        result.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        result.add(bindings.name.text)
      }
      else if (bindings) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly)
            result.add(element.name.text)
        }
      }
    }
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        addBindingName(declaration.name)
    }
    else if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || (!allowNamespaceMerge && ts.isModuleDeclaration(statement))) && statement.name) {
      result.add(statement.name.text)
    }
  }
  return result
}

function collectSpecifierConflicts(sourceFile: ts.SourceFile, ignoredImports: Set<ts.ImportDeclaration>) {
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
      if (clause?.name)
        result.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        result.add(bindings.name.text)
      }
      else if (bindings) {
        for (const element of bindings.elements) {
          const promotableTypeBinding = ignoredImports.has(statement) && (clause?.isTypeOnly || element.isTypeOnly)
          if (!promotableTypeBinding)
            result.add(element.name.text)
        }
      }
    }
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        addBindingName(declaration.name)
    }
    else if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      result.add(statement.name.text)
    }
  }
  return result
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
    else if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name) {
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

function getScriptRegion(code: string, host: ImportHost, context: ImportDocumentContext): ScriptRegion | null {
  if (host === 'script') {
    const language = context.languageId?.toLowerCase()
    const extension = context.uri?.match(/\.([^.?#/]+)(?:[?#]|$)/)?.[1]?.toLowerCase()
    const kind = language === 'typescriptreact' || extension === 'tsx'
      ? ts.ScriptKind.TSX
      : language === 'javascriptreact' || extension === 'jsx'
        ? ts.ScriptKind.JSX
        : language === 'javascript' || extension === 'js'
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
    return { code, offset: 0, scriptKind: kind, fileName: `component.${extension || (kind === ts.ScriptKind.TSX ? 'tsx' : kind === ts.ScriptKind.JSX ? 'jsx' : kind === ts.ScriptKind.JS ? 'js' : 'ts')}` }
  }

  if (host === 'svelte') {
    const instance = getSvelteInstanceScript(code)
    if (!instance)
      return null
    const openingTagStart = code.lastIndexOf('<script', instance.offset)
    const openingTag = openingTagStart >= 0 ? code.slice(openingTagStart, instance.offset) : ''
    const lang = openingTag.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase()
    const scriptKind = lang === 'ts' || lang === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS
    return { code: instance.content, offset: instance.offset, scriptKind, fileName: `component.${scriptKind === ts.ScriptKind.TS ? 'ts' : 'js'}` }
  }

  const { descriptor } = parseVueSfc(code)
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block && !block.src)
  let selected
  if (context.preferredVueBlock) {
    selected = context.preferredVueBlock === 'scriptSetup' ? descriptor.scriptSetup : descriptor.script
    if (!selected || selected.src)
      return null
    if (context.expectedBlockLang !== undefined && (selected.lang || '') !== context.expectedBlockLang)
      return null
  }
  else {
    const preferred = typeof context.preferredOffset === 'number'
      ? blocks.find(block => context.preferredOffset! >= block!.loc.start.offset && context.preferredOffset! <= block!.loc.end.offset)
      : undefined
    selected = preferred || (descriptor.scriptSetup && !descriptor.scriptSetup.src
      ? descriptor.scriptSetup
      : descriptor.script && !descriptor.script.src ? descriptor.script : undefined)
  }
  if (!selected)
    return null
  const lang = selected.lang?.toLowerCase()
  const scriptKind = lang === 'tsx' ? ts.ScriptKind.TSX : lang === 'jsx' ? ts.ScriptKind.JSX : lang === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS
  return { code: selected.content, offset: selected.loc.start.offset, scriptKind, fileName: `component.${lang || 'js'}`, vueMode: selected === descriptor.scriptSetup ? 'setup' : 'normal' }
}

function canCreateVueScript(code: string) {
  const { descriptor, errors } = parseVueSfc(code)
  return !descriptor.script && !descriptor.scriptSetup
    && !errors.some((error: any) => String(error?.message || error).includes('<script setup> cannot use the "src" attribute'))
}

function isVueComponentFactory(expression: ts.LeftHandSideExpression) {
  return ts.isIdentifier(expression)
    && (expression.text === 'defineComponent' || expression.text === 'defineNuxtComponent')
}

function getVueRegistrationEdits(sourceFile: ts.SourceFile, script: ScriptRegion, names: string[]): ImportEdit[] | null {
  const assignment = sourceFile.statements.find(ts.isExportAssignment)
  if (!assignment || assignment.isExportEquals)
    return null
  let object: ts.ObjectLiteralExpression | undefined
  if (ts.isObjectLiteralExpression(assignment.expression)) {
    object = assignment.expression
  }
  else if (ts.isCallExpression(assignment.expression)
    && isVueComponentFactory(assignment.expression.expression)
    && assignment.expression.arguments[0]
    && ts.isObjectLiteralExpression(assignment.expression.arguments[0])) {
    object = assignment.expression.arguments[0]
  }
  if (!object || object.properties.some(ts.isSpreadAssignment))
    return null

  const getStaticPropertyName = (name: ts.PropertyName | undefined) => {
    if (!name)
      return
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      return name.text
    if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression))
      return name.expression.text
  }
  const components = object.properties.find(property => getStaticPropertyName(property.name) === 'components')
  if (!components) {
    if (object.properties.some(property => property.name && ts.isComputedPropertyName(property.name) && !ts.isStringLiteral(property.name.expression)))
      return null
    const insertion = object.getStart(sourceFile) + 1
    return [{ start: script.offset + insertion, end: script.offset + insertion, text: `\n  components: { ${names.join(', ')} },` }]
  }
  if (!ts.isPropertyAssignment(components) || !ts.isObjectLiteralExpression(components.initializer))
    return null
  const existing = new Set(components.initializer.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property))
      return [property.name.text]
    const name = getStaticPropertyName(property.name)
    return name ? [name] : []
  }))
  const missing = names.filter(name => !existing.has(name))
  if (!missing.length)
    return []
  const initializer = components.initializer
  const insertion = initializer.end - 1
  const lastProperty = initializer.properties.at(-1)
  const tail = lastProperty ? sourceFile.text.slice(lastProperty.end, insertion) : ''
  const prefix = !lastProperty ? ' ' : tail.includes(',') ? '' : ', '
  return [{ start: script.offset + insertion, end: script.offset + insertion, text: `${prefix}${missing.join(', ')} ` }]
}

export function isSafeBindingIdentifier(name: string) {
  if (!name)
    return false
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name)
  return scanner.scan() === ts.SyntaxKind.Identifier
    && scanner.getTokenText() === name
    && scanner.scan() === ts.SyntaxKind.EndOfFileToken
}
