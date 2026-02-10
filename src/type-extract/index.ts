import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import process from 'node:process'
import * as ts from 'typescript'
import { getRootPath } from '@vscode-use/utils'
import type { Component, EventItem, PropsItem, typeDetail, typeDetailItem } from '../ui/ui-type'
import { componentsReducer, hyphenate, propsReducer } from '../ui/utils'
import { fixedTagName } from '../ui/ui-utils'
import { typeCache } from './cache'

interface TypeExtractOptions {
  pkgName: string
  uiName: string
  resolveFrom?: string
}

interface ExtractedComponent {
  component: Component
  reactLike: boolean
}

const MAX_TYPE_DEPTH = 6
const MAX_TYPE_DETAIL_DEPTH = 3
const MAX_TYPE_DETAIL_MEMBERS = 60
const MAX_TYPE_DETAIL_UNION_MEMBERS = 6
const MAX_INLINE_TYPE_DEPTH = 3
const MAX_INLINE_TYPE_PROPS = 10
const MAX_INLINE_TYPE_LENGTH = 240
const MAX_INLINE_UNION_MEMBERS = 6
const RESOLVE_EXTENSIONS = ['.d.ts', '.ts', '.tsx', '.js', '.mjs', '.cjs']

export async function fetchFromTypes(options: TypeExtractOptions) {
  const { pkgName, uiName } = options
  if (!pkgName || !uiName)
    return

  const basePath = options.resolveFrom
    ? path.extname(options.resolveFrom)
      ? path.dirname(options.resolveFrom)
      : options.resolveFrom
    : (getRootPath() || process.cwd())
  const requireBase = path.resolve(basePath, 'package.json')
  const require = createRequire(requireBase)
  let pkgJsonPath = ''
  try {
    pkgJsonPath = require.resolve(`${pkgName}/package.json`)
  }
  catch {
    return
  }

  const pkgRoot = path.dirname(pkgJsonPath)
  const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf-8'))
  const version = pkgJson?.version || '0.0.0'
  const cacheKey = `${pkgName}@${version}`
  if (typeCache.has(cacheKey))
    return typeCache.get(cacheKey)

  const typeEntry = resolveTypesEntry(pkgJson, pkgRoot)
  if (!typeEntry)
    return
  const globalDts = path.resolve(pkgRoot, 'global.d.ts')
  const rootNames = [
    typeEntry,
    ...(existsSync(globalDts) ? [globalDts] : []),
  ]

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
    allowJs: false,
    strictNullChecks: true,
  }
  const host = ts.createCompilerHost(compilerOptions)
  const origResolveModuleNames = host.resolveModuleNames?.bind(host)
  host.resolveModuleNames = (moduleNames, containingFile, ...rest) => {
    const baseResolved = origResolveModuleNames
      ? origResolveModuleNames(moduleNames, containingFile, ...rest)
      : moduleNames.map(name => ts.resolveModuleName(name, containingFile, compilerOptions, host).resolvedModule)
    return moduleNames.map((name, index) => {
      const resolved = baseResolved?.[index]
      const preferred = preferDtsResolved(resolved)
      if (preferred)
        return preferred
      const fallback = resolveModuleFallback(name, containingFile, compilerOptions, host)
      return preferDtsResolved(fallback)
    })
  }
  const program = ts.createProgram(rootNames, compilerOptions, host)
  const checker = program.getTypeChecker()
  const components = collectComponents(program, checker, pkgRoot, typeEntry)
  if (!components.length)
    return

  const reactLikeCount = components.filter(c => c.reactLike).length
  const isReact = reactLikeCount > 0 && reactLikeCount >= Math.ceil(components.length / 2)
  const map = components.map(({ component }) => [component, component.name] as [Component, string])

  const componentsConfig = componentsReducer({
    map,
    lib: pkgName,
    isReact,
  })
  const propsConfig = propsReducer({
    uiName,
    lib: pkgName,
    map: components.map(c => c.component),
  })
  const rawComponents = components.map(c => c.component)
  // Alias kebab-case component names to improve props lookup in templates.
  for (const key of Object.keys(propsConfig)) {
    if (!key || key.includes('-'))
      continue
    const kebab = hyphenate(key[0].toLowerCase() + key.slice(1))
    if (!propsConfig[kebab])
      propsConfig[kebab] = propsConfig[key]
  }

  const result = {
    [`${uiName}Components`]: () => componentsConfig,
    [`${uiName}`]: () => propsConfig,
    [`${uiName}Raw`]: () => rawComponents,
  }
  typeCache.set(cacheKey, result)
  return result
}

function resolveTypesEntry(pkgJson: any, pkgRoot: string) {
  const candidates: string[] = []

  const direct = pkgJson?.types || pkgJson?.typings
  if (direct)
    candidates.push(path.resolve(pkgRoot, direct))

  const exportsField = pkgJson?.exports
  if (exportsField && typeof exportsField === 'object') {
    const rootExport = exportsField['.'] || exportsField
    if (rootExport && typeof rootExport === 'object') {
      const typesEntry = rootExport.types || rootExport.typings
      if (typesEntry)
        candidates.push(path.resolve(pkgRoot, typesEntry))
      const maybeDts = rootExport.default
      if (typeof maybeDts === 'string' && maybeDts.endsWith('.d.ts'))
        candidates.push(path.resolve(pkgRoot, maybeDts))
    }
  }

  candidates.push(
    path.resolve(pkgRoot, 'types/index.d.ts'),
    path.resolve(pkgRoot, 'typings/index.d.ts'),
    path.resolve(pkgRoot, 'dist/index.d.ts'),
    path.resolve(pkgRoot, 'es/index.d.ts'),
    path.resolve(pkgRoot, 'lib/index.d.ts'),
    path.resolve(pkgRoot, 'index.d.ts'),
    path.resolve(pkgRoot, 'global.d.ts'),
  )

  for (const entry of candidates) {
    if (existsSync(entry))
      return entry
  }
}

function resolveModuleFallback(
  moduleName: string,
  containingFile: string,
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
) {
  const candidates: string[] = []
  const ext = path.extname(moduleName)
  if (ext) {
    const base = moduleName.slice(0, -ext.length)
    for (const replacement of RESOLVE_EXTENSIONS) {
      if (replacement === ext)
        continue
      candidates.push(`${base}${replacement}`)
    }
  }
  else {
    for (const replacement of RESOLVE_EXTENSIONS)
      candidates.push(`${moduleName}${replacement}`)
  }

  for (const candidate of candidates) {
    const resolved = ts.resolveModuleName(candidate, containingFile, options, host).resolvedModule
    if (resolved)
      return resolved
  }
  return undefined
}

function preferDtsResolved(resolved?: ts.ResolvedModuleFull) {
  if (!resolved?.resolvedFileName)
    return resolved
  const ext = path.extname(resolved.resolvedFileName)
  if (ext === '.d.ts')
    return resolved
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') {
    const candidate = resolved.resolvedFileName.replace(ext, '.d.ts')
    if (existsSync(candidate)) {
      return {
        ...resolved,
        resolvedFileName: candidate,
        extension: ts.Extension.Dts,
      }
    }
  }
  return resolved
}

function collectComponents(program: ts.Program, checker: ts.TypeChecker, pkgRoot: string, entry: string) {
  const fromGlobals = collectVueGlobalComponents(program, checker, pkgRoot)
  if (fromGlobals.length)
    return fromGlobals

  return collectExports(program, checker, entry)
}

function collectVueGlobalComponents(program: ts.Program, checker: ts.TypeChecker, pkgRoot: string): ExtractedComponent[] {
  const result = new Map<string, ExtractedComponent>()
  const normalizedRoot = path.resolve(pkgRoot)

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile)
      continue
    if (!sourceFile.fileName.startsWith(normalizedRoot))
      continue

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isModuleDeclaration(node))
        return
      if (!node.name)
        return
      const moduleName = ts.isStringLiteral(node.name) ? node.name.text : ts.isIdentifier(node.name) ? node.name.text : ''
      if (moduleName !== 'vue')
        return
      if (!node.body || !ts.isModuleBlock(node.body))
        return

      for (const stmt of node.body.statements) {
        if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'GlobalComponents')
          continue
        for (const member of stmt.members) {
          if (!ts.isPropertySignature(member) || !member.name)
            continue
          const rawName = getMemberName(member.name)
          if (!rawName)
            continue
          const name = fixedTagName(rawName)
          if (!name || name.startsWith('_'))
            continue
          const type = checker.getTypeAtLocation(member)
          const component = buildComponent(name, type, checker, member)
          if (!component)
            continue
          result.set(name, component)
        }
      }
    })
  }

  return [...result.values()]
}

function collectExports(program: ts.Program, checker: ts.TypeChecker, entry: string): ExtractedComponent[] {
  const source = program.getSourceFile(entry)
  if (!source)
    return []

  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol)
    return []

  const result = new Map<string, ExtractedComponent>()
  for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
    const name = exportSymbol.getName()
    if (!isComponentName(name))
      continue
    const decl = exportSymbol.valueDeclaration || exportSymbol.declarations?.[0] || source
    const type = checker.getTypeOfSymbolAtLocation(exportSymbol, decl)
    if (!isComponentLike(type))
      continue
    const component = buildComponent(name, type, checker, decl, exportSymbol)
    if (!component)
      continue
    result.set(name, component)
  }

  return [...result.values()]
}

function buildComponent(
  name: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  decl: ts.Node,
  symbol?: ts.Symbol,
): ExtractedComponent | null {
  const propsInfo = extractPropsType(type, checker, decl)
  const props = propsInfo?.propsType ? typeToProps(propsInfo.propsType, checker, decl) : {}
  const events = extractEvents(type, checker, decl)
  const description = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)) : ''
  const component: Component = {
    name,
    description,
    props,
    events,
    methods: [],
    slots: [],
    exposed: [],
  }
  return { component, reactLike: propsInfo?.reactLike || false }
}

function extractEvents(type: ts.Type, checker: ts.TypeChecker, decl: ts.Node): EventItem[] {
  const events = new Map<string, EventItem>()

  const addEvent = (name: string, params?: string) => {
    if (!name)
      return
    const existing = events.get(name)
    if (existing) {
      if (!existing.params && params)
        existing.params = params
      return
    }
    events.set(name, { name, params })
  }

  const propDefSymbol = type.getProperty('__propDef')
  if (propDefSymbol) {
    const propDefType = checker.getTypeOfSymbolAtLocation(propDefSymbol, propDefSymbol.valueDeclaration || decl)
    const emitsType = getDirectPropsType(propDefType, checker, decl, 'emits')
      || getDirectPropsType(propDefType, checker, decl, 'events')
    if (emitsType)
      collectEventsFromEmitsType(emitsType, checker, decl, addEvent)
  }

  const directEmits = getDirectPropsType(type, checker, decl, 'emits')
  if (directEmits)
    collectEventsFromEmitsType(directEmits, checker, decl, addEvent)

  const svelteEvents = getDirectPropsType(type, checker, decl, '$$events_def')
  if (svelteEvents)
    collectEventsFromEmitsType(svelteEvents, checker, decl, addEvent)

  const typeArgs = extractComponentTypeArgs(type, checker)
  if (typeArgs.emitsType)
    collectEventsFromEmitsType(typeArgs.emitsType, checker, decl, addEvent)

  const instanceType = findComponentInstanceType(type, checker)
  if (instanceType) {
    const emitSymbol = instanceType.getProperty('$emit')
    if (emitSymbol) {
      const emitType = checker.getTypeOfSymbolAtLocation(emitSymbol, emitSymbol.valueDeclaration || decl)
      collectEventsFromEmitSignatures(emitType, checker, decl, addEvent)
    }
  }

  return [...events.values()]
}

function collectEventsFromEmitsType(
  type: ts.Type,
  checker: ts.TypeChecker,
  decl: ts.Node,
  addEvent: (name: string, params?: string) => void,
) {
  const apparent = checker.getApparentType(type)

  if (apparent.isUnion() || apparent.isIntersection()) {
    for (const t of apparent.types)
      collectEventsFromEmitsType(t, checker, decl, addEvent)
    return
  }

  const literalNames = extractStringLiterals(apparent)
  if (literalNames.length) {
    for (const name of literalNames)
      addEvent(name)
  }

  const elementType = getArrayElementType(apparent, checker)
  if (elementType) {
    const names = extractStringLiterals(elementType)
    for (const name of names)
      addEvent(name)
  }

  const props = apparent.getProperties()
  if (!props.length)
    return

  for (const prop of props) {
    const rawName = getSymbolName(prop)
    if (!rawName || rawName.startsWith('_') || rawName.startsWith('$'))
      continue
    const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration || decl)
    const params = formatEventParamsFromType(propType, checker, decl)
    addEvent(rawName, params)
  }
}

function collectEventsFromEmitSignatures(
  type: ts.Type,
  checker: ts.TypeChecker,
  decl: ts.Node,
  addEvent: (name: string, params?: string) => void,
) {
  const signatures = type.getCallSignatures()
  for (const signature of signatures) {
    const params = signature.getParameters()
    if (!params.length)
      continue
    const eventParam = params[0]
    const eventType = checker.getTypeOfSymbolAtLocation(eventParam, eventParam.valueDeclaration || decl)
    const names = extractStringLiterals(eventType)
    if (!names.length)
      continue
    const paramsString = formatEventParamsFromSignature(signature, checker, decl)
    for (const name of names)
      addEvent(name, paramsString)
  }
}

function formatEventParamsFromType(type: ts.Type, checker: ts.TypeChecker, decl: ts.Node) {
  if (!type)
    return
  if (type.getCallSignatures().length)
    return cleanTypeText(checker.typeToString(type, decl, ts.TypeFormatFlags.NoTruncation))
}

function formatEventParamsFromSignature(signature: ts.Signature, checker: ts.TypeChecker, decl: ts.Node) {
  const params = signature.getParameters().slice(1)
  if (!params.length)
    return
  const parts = params.map((param) => {
    const declNode = param.valueDeclaration
    const paramType = checker.getTypeOfSymbolAtLocation(param, declNode || decl)
    const typeString = cleanTypeText(checker.typeToString(paramType, decl, ts.TypeFormatFlags.NoTruncation))
    const isOptional = (param.getFlags() & ts.SymbolFlags.Optional) !== 0
      || (declNode && ts.isParameter(declNode) && !!declNode.questionToken)
    const isRest = declNode && ts.isParameter(declNode) && !!declNode.dotDotDotToken
    const name = `${isRest ? '...' : ''}${param.getName()}${isOptional ? '?' : ''}`
    return `${name}: ${typeString}`
  })
  return `(${parts.join(', ')}) => void`
}

function findComponentInstanceType(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): ts.Type | null {
  if (seen.has(type))
    return null
  seen.add(type)

  const ctor = type.getConstructSignatures()
  if (ctor.length)
    return ctor[0].getReturnType()

  const call = type.getCallSignatures()
  if (call.length)
    return call[0].getReturnType()

  if (type.isIntersection() || type.isUnion()) {
    for (const t of type.types) {
      const found = findComponentInstanceType(t, checker, seen)
      if (found)
        return found
    }
  }

  const apparent = checker.getApparentType(type)
  if (apparent !== type)
    return findComponentInstanceType(apparent, checker, seen)

  return null
}

function extractComponentTypeArgs(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()) {
  if (seen.has(type))
    return {} as { propsType?: ts.Type, emitsType?: ts.Type }
  seen.add(type)

  if (type.isIntersection() || type.isUnion()) {
    let propsType: ts.Type | undefined
    let emitsType: ts.Type | undefined
    for (const t of type.types) {
      const result = extractComponentTypeArgs(t, checker, seen)
      if (result.propsType)
        propsType = pickBetterProps(propsType, result.propsType, checker)
      if (!emitsType && result.emitsType)
        emitsType = result.emitsType
    }
    return { propsType, emitsType }
  }

  const aliasName = type.aliasSymbol?.getName()
  const aliasArgs = type.aliasTypeArguments
  if (aliasName && aliasArgs?.length) {
    if (aliasName === 'DefineSetupFnComponent') {
      return { propsType: aliasArgs[0], emitsType: aliasArgs[1] }
    }
    if (aliasName === 'DefineComponent') {
      const propsType = aliasArgs[10] || aliasArgs[0]
      const emitsType = aliasArgs[7]
      return { propsType, emitsType }
    }
    if (aliasName === 'FunctionalComponent') {
      return { propsType: aliasArgs[0], emitsType: aliasArgs[1] }
    }
  }

  const ref = getTypeReference(type)
  if (ref) {
    const targetName = ref.target?.symbol?.getName()
    const args = checker.getTypeArguments(ref)
    if (targetName === 'DefineSetupFnComponent') {
      return { propsType: args[0], emitsType: args[1] }
    }
    if (targetName === 'DefineComponent') {
      const propsType = args[10] || args[0]
      const emitsType = args[7]
      return { propsType, emitsType }
    }
    if (targetName === 'FunctionalComponent') {
      return { propsType: args[0], emitsType: args[1] }
    }
  }

  const apparent = checker.getApparentType(type)
  if (apparent !== type)
    return extractComponentTypeArgs(apparent, checker, seen)

  return {} as { propsType?: ts.Type, emitsType?: ts.Type }
}

function pickBetterProps(a: ts.Type | undefined, b: ts.Type | undefined, checker: ts.TypeChecker) {
  if (!a)
    return b
  if (!b)
    return a
  const aCount = checker.getApparentType(a).getProperties().length
  const bCount = checker.getApparentType(b).getProperties().length
  return bCount > aCount ? b : a
}

function getTypeReference(type: ts.Type): ts.TypeReference | null {
  const obj = type as ts.ObjectType
  if (obj?.objectFlags && (obj.objectFlags & ts.ObjectFlags.Reference))
    return type as ts.TypeReference
  return null
}

function extractStringLiterals(type: ts.Type) {
  if (type.isStringLiteral())
    return [type.value]
  if (type.isUnion()) {
    const values: string[] = []
    for (const part of type.types) {
      if (part.isStringLiteral())
        values.push(part.value)
      else
        return []
    }
    return values
  }
  return []
}

function getArrayElementType(type: ts.Type, checker: ts.TypeChecker) {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      || checker.getElementTypeOfArrayType(type)
      || null
  }
  return checker.getIndexTypeOfType(type, ts.IndexKind.Number) || null
}

function getSymbolName(symbol: ts.Symbol) {
  const decl = symbol.valueDeclaration
  if (decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.name) {
    const member = getMemberName(decl.name)
    if (member)
      return member
  }
  const name = symbol.getName()
  if (name.startsWith('"') && name.endsWith('"'))
    return name.slice(1, -1)
  if (name.startsWith('\'') && name.endsWith('\''))
    return name.slice(1, -1)
  return name
}

function extractPropsType(type: ts.Type, checker: ts.TypeChecker, decl: ts.Node) {
  const propDef = getPropDefType(type, checker, decl)
  if (propDef)
    return { propsType: propDef, reactLike: false }

  const svelteProps = getDirectPropsType(type, checker, decl, '$$prop_def')
  if (svelteProps)
    return { propsType: svelteProps, reactLike: false }

  const typeArgs = extractComponentTypeArgs(type, checker)
  if (typeArgs.propsType)
    return { propsType: typeArgs.propsType, reactLike: false }

  const defineSetup = getDirectPropsType(type, checker, decl, 'props')
  if (defineSetup)
    return { propsType: defineSetup, reactLike: false }

  const ctorSigs = type.getConstructSignatures()
  if (ctorSigs.length) {
    const instanceType = ctorSigs[0].getReturnType()
    const propsType = getDirectPropsType(instanceType, checker, decl, '$props')
      || getDirectPropsType(instanceType, checker, decl, 'props')
      || getDirectPropsType(instanceType, checker, decl, 'props')
    if (propsType)
      return { propsType, reactLike: false }
  }

  const callSigs = type.getCallSignatures()
  if (callSigs.length && callSigs[0].getParameters().length) {
    const param = callSigs[0].getParameters()[0]
    const propsType = checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration || decl)
    return { propsType, reactLike: true }
  }

  return null
}

function getPropDefType(type: ts.Type, checker: ts.TypeChecker, decl: ts.Node) {
  const propDefSymbol = type.getProperty('__propDef')
  if (!propDefSymbol)
    return null
  const propDefType = checker.getTypeOfSymbolAtLocation(propDefSymbol, propDefSymbol.valueDeclaration || decl)
  return getDirectPropsType(propDefType, checker, decl, 'props')
}

function getDirectPropsType(type: ts.Type, checker: ts.TypeChecker, decl: ts.Node, propName: string) {
  const propSymbol = type.getProperty(propName)
  if (!propSymbol)
    return null
  return checker.getTypeOfSymbolAtLocation(propSymbol, propSymbol.valueDeclaration || decl)
}

function isRenderablePropName(name: string) {
  if (!name)
    return false
  if (name.startsWith('$') || name.startsWith('_'))
    return false
  if (name === 'class' || name === 'style' || name === 'key' || name === 'ref')
    return false
  return true
}

function typeToProps(type: ts.Type, checker: ts.TypeChecker, decl: ts.Node) {
  const props: Record<string, PropsItem> = {}
  const propSymbols = new Map<string, ts.Symbol>()
  const normalizedType = unwrapComponentPropsOptions(type, checker)
  collectPropSymbols(normalizedType, checker, propSymbols)
  for (const prop of propSymbols.values()) {
    const name = prop.getName()
    if (!isRenderablePropName(name))
      continue

    const contextNode = prop.valueDeclaration || decl
    const directType = checker.getTypeOfPropertyOfType(normalizedType, name)
    let propType = (directType && !(directType.flags & ts.TypeFlags.Never))
      ? directType
      : checker.getTypeOfSymbolAtLocation(prop, contextNode)
    const declType = resolvePropTypeFromTypeDecls(normalizedType, checker, name)
    if (declType && shouldPreferDeclType(propType, declType, checker, contextNode))
      propType = declType
    let declInfo = getTypeInfoFromDecl(prop, checker)
    const declNode = resolvePropTypeNodeFromTypeDecls(normalizedType, checker, name)
    if (declNode && (!declInfo?.rawText || !declInfo?.expandedText || !declInfo?.literals?.length)) {
      const fallbackRaw = declNode.getText()
      const fallbackExpanded = expandTypeNodeForDisplay(declNode, checker, declNode)
      const resolved = resolveTypeInfoFromNode(declNode, checker, declNode)
      declInfo = {
        ...declInfo,
        text: declInfo?.text || resolved.text || fallbackRaw,
        rawText: declInfo?.rawText || fallbackRaw,
        expandedText: declInfo?.expandedText || fallbackExpanded,
        literals: declInfo?.literals?.length ? declInfo.literals : resolved.literals,
      }
    }
    const isOptional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0
    let { typeString, value } = formatPropType(propType, checker, contextNode, declInfo, isOptional)
    if (declNode) {
      const expanded = declInfo?.expandedText || expandTypeNodeForDisplay(declNode, checker, declNode)
      const fallbackText = cleanTypeText(expanded || declNode.getText())
      const shouldReplace = fallbackText && !isWeakTypeString(fallbackText)
        && (isWeakTypeString(typeString) || (isAliasLikeType(typeString) && fallbackText !== typeString))
      if (shouldReplace) {
        typeString = fallbackText
        if (isOptional)
          typeString = stripUndefinedFromUnion(typeString)
        if (typeof value === 'string' && isWeakTypeString(value))
          value = typeString
      }
    }
    const description = ts.displayPartsToString(prop.getDocumentationComment(checker))
    const typeDetail = buildTypeDetailFromProp(prop, propType, checker, contextNode)

    props[name] = {
      default: undefined,
      value,
      type: typeString,
      typeDetail,
      description,
      required: !isOptional,
    }
  }
  return props
}

function unwrapComponentPropsOptions(type: ts.Type, checker: ts.TypeChecker) {
  const ref = getTypeReference(type) || getTypeReference(checker.getApparentType(type))
  const targetName = ref?.target?.symbol?.getName()
  if (targetName === 'ComponentPropsOptions' || targetName === 'ComponentObjectPropsOptions') {
    const args = ref ? checker.getTypeArguments(ref) : []
    if (args?.[0])
      return args[0]
  }
  const aliasName = type.aliasSymbol?.getName()
  if ((aliasName === 'ComponentPropsOptions' || aliasName === 'ComponentObjectPropsOptions') && type.aliasTypeArguments?.[0])
    return type.aliasTypeArguments[0]
  return type
}

function collectPropSymbols(
  type: ts.Type,
  checker: ts.TypeChecker,
  out: Map<string, ts.Symbol>,
  seen = new Set<ts.Type>(),
  seenDecls = new Set<ts.Node>(),
) {
  if (seen.has(type))
    return
  seen.add(type)

  const symbol = type.symbol || type.aliasSymbol
  if (symbol) {
    const targetSymbol = (symbol.getFlags() & ts.SymbolFlags.Alias)
      ? checker.getAliasedSymbol(symbol)
      : symbol
    const declared = checker.getDeclaredTypeOfSymbol(targetSymbol)
    if (declared && declared !== type && !seen.has(declared))
      collectPropSymbols(declared, checker, out, seen, seenDecls)
  }

  const apparent = checker.getApparentType(type)
  const props = apparent.getProperties()
  if (props.length) {
    for (const prop of props)
      out.set(prop.getName(), prop)
    const hasRenderable = props.some(prop => isRenderablePropName(prop.getName()))
    if (hasRenderable)
      return
  }

  if (apparent.isClassOrInterface()) {
    const bases = checker.getBaseTypes(apparent)
    for (const base of bases)
      collectPropSymbols(base, checker, out, seen, seenDecls)
  }
  const decls = type.symbol?.declarations || type.aliasSymbol?.declarations
  if (decls?.length) {
    for (const decl of decls) {
      if (!ts.isInterfaceDeclaration(decl) && !ts.isClassDeclaration(decl))
        continue
      if (seenDecls.has(decl))
        continue
      seenDecls.add(decl)
      for (const member of decl.members) {
        if (!member.name || (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)))
          continue
        const propSymbol = checker.getSymbolAtLocation(member.name)
        if (propSymbol)
          out.set(getSymbolName(propSymbol), propSymbol)
      }
      const clauses = decl.heritageClauses || []
      for (const clause of clauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword)
          continue
        for (const heritageType of clause.types) {
          const handled = collectPropsFromHeritageTypeNode(heritageType, checker, out, seen)
          if (handled)
            continue
          const baseType = checker.getTypeAtLocation(heritageType)
          if (baseType)
            collectPropSymbols(baseType, checker, out, seen, seenDecls)
        }
      }
    }
  }

  const mapped = getMappedTypeProps(type, checker, seen)
  if (mapped?.length) {
    for (const prop of mapped)
      out.set(prop.getName(), prop)
    return
  }

  if (type.isIntersection() || type.isUnion()) {
    for (const t of type.types)
      collectPropSymbols(t, checker, out, seen, seenDecls)
  }
}

function isLikelyEmptyObjectType(type: ts.Type, checker: ts.TypeChecker) {
  const apparent = checker.getApparentType(type)
  if (apparent.isUnion() || apparent.isIntersection())
    return false
  if (checker.isArrayType(apparent) || checker.isTupleType(apparent))
    return false
  if (apparent.getCallSignatures().length)
    return false
  if (apparent.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    return false
  return apparent.getProperties().length === 0
}

function shouldPreferDeclType(
  current: ts.Type,
  candidate: ts.Type,
  checker: ts.TypeChecker,
  context: ts.Node,
) {
  if (!current)
    return true
  if (current.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    return true
  if (isLikelyEmptyObjectType(current, checker))
    return true
  const text = cleanTypeText(checker.typeToString(checker.getApparentType(current), context, ts.TypeFormatFlags.NoTruncation))
  if (text === '{}' || text === 'object')
    return true
  return false
}

function resolvePropTypeFromTypeDecls(
  type: ts.Type,
  checker: ts.TypeChecker,
  propName: string,
  seen = new Set<ts.Type>(),
): ts.Type | null {
  if (seen.has(type))
    return null
  seen.add(type)

  const apparent = checker.getApparentType(type)
  if (apparent.isUnion() || apparent.isIntersection()) {
    for (const part of apparent.types) {
      const resolved = resolvePropTypeFromTypeDecls(part, checker, propName, seen)
      if (resolved)
        return resolved
    }
    return null
  }

  const ref = getTypeReference(type)
  const refSymbol = ref?.target?.symbol
  const declSymbol = type.symbol || type.aliasSymbol || refSymbol
  const decls = declSymbol?.declarations
  if (decls?.length) {
    for (const decl of decls) {
      if (!ts.isInterfaceDeclaration(decl) && !ts.isClassDeclaration(decl))
        continue
      for (const member of decl.members) {
        if (!member.name || (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)))
          continue
        const memberName = getMemberName(member.name)
        if (!memberName || memberName !== propName)
          continue
        if (member.type)
          return checker.getTypeFromTypeNode(member.type)
      }
      const clauses = decl.heritageClauses || []
      for (const clause of clauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword)
          continue
        for (const heritageType of clause.types) {
          const resolved = resolvePropTypeFromHeritageTypeNode(heritageType, checker, propName, seen)
          if (resolved)
            return resolved
        }
      }
    }
  }

  if (apparent.isClassOrInterface()) {
    const bases = checker.getBaseTypes(apparent)
    for (const base of bases) {
      const resolved = resolvePropTypeFromTypeDecls(base, checker, propName, seen)
      if (resolved)
        return resolved
    }
  }

  return null
}

function resolvePropTypeNodeFromTypeDecls(
  type: ts.Type,
  checker: ts.TypeChecker,
  propName: string,
  seen = new Set<ts.Type>(),
): ts.TypeNode | null {
  if (seen.has(type))
    return null
  seen.add(type)

  const apparent = checker.getApparentType(type)
  if (apparent.isUnion() || apparent.isIntersection()) {
    for (const part of apparent.types) {
      const resolved = resolvePropTypeNodeFromTypeDecls(part, checker, propName, seen)
      if (resolved)
        return resolved
    }
    return null
  }

  const ref = getTypeReference(type)
  const refSymbol = ref?.target?.symbol
  const declSymbol = type.symbol || type.aliasSymbol || refSymbol
  const decls = declSymbol?.declarations
  if (decls?.length) {
    for (const decl of decls) {
      if (!ts.isInterfaceDeclaration(decl) && !ts.isClassDeclaration(decl))
        continue
      for (const member of decl.members) {
        if (!member.name || (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)))
          continue
        const memberName = getMemberName(member.name)
        if (!memberName || memberName !== propName)
          continue
        if (member.type)
          return member.type
      }
      const clauses = decl.heritageClauses || []
      for (const clause of clauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword)
          continue
        for (const heritageType of clause.types) {
          const resolved = resolvePropTypeNodeFromHeritageTypeNode(heritageType, checker, propName, seen)
          if (resolved)
            return resolved
        }
      }
    }
  }

  if (apparent.isClassOrInterface()) {
    const bases = checker.getBaseTypes(apparent)
    for (const base of bases) {
      const resolved = resolvePropTypeNodeFromTypeDecls(base, checker, propName, seen)
      if (resolved)
        return resolved
    }
  }

  return null
}

function resolvePropTypeNodeFromHeritageTypeNode(
  node: ts.ExpressionWithTypeArguments | ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  propName: string,
  seen: Set<ts.Type>,
): ts.TypeNode | null {
  const name = getHeritageTypeName(node)
  const typeArgs = (ts.isExpressionWithTypeArguments(node) ? node.typeArguments : node.typeArguments) || []
  if (!name || !typeArgs.length) {
    const baseType = checker.getTypeAtLocation(node)
    return baseType ? resolvePropTypeNodeFromTypeDecls(baseType, checker, propName, seen) : null
  }

  if (name === 'Omit' || name === 'Pick') {
    const baseNode = typeArgs[0]
    if (!baseNode)
      return null
    const keyNode = typeArgs[1]
    const keyType = keyNode ? checker.getTypeFromTypeNode(keyNode) : null
    const keys = keyType ? extractStringLiterals(keyType) : []
    if (name === 'Pick' && keys.length && !keys.includes(propName))
      return null
    if (name === 'Omit' && keys.includes(propName))
      return null
    const baseType = checker.getTypeFromTypeNode(baseNode)
    return resolvePropTypeNodeFromTypeDecls(baseType, checker, propName, seen)
  }

  if (name === 'Partial' || name === 'Required' || name === 'Readonly') {
    const baseNode = typeArgs[0]
    if (!baseNode)
      return null
    const baseType = checker.getTypeFromTypeNode(baseNode)
    return resolvePropTypeNodeFromTypeDecls(baseType, checker, propName, seen)
  }

  const baseType = checker.getTypeAtLocation(node)
  return baseType ? resolvePropTypeNodeFromTypeDecls(baseType, checker, propName, seen) : null
}

function resolvePropTypeFromHeritageTypeNode(
  node: ts.ExpressionWithTypeArguments | ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  propName: string,
  seen: Set<ts.Type>,
) {
  const name = getHeritageTypeName(node)
  const typeArgs = (ts.isExpressionWithTypeArguments(node) ? node.typeArguments : node.typeArguments) || []
  if (!name || !typeArgs.length) {
    const baseType = checker.getTypeAtLocation(node)
    return baseType ? resolvePropTypeFromTypeDecls(baseType, checker, propName, seen) : null
  }

  if (name === 'Omit' || name === 'Pick') {
    const baseNode = typeArgs[0]
    if (!baseNode)
      return null
    const baseType = checker.getTypeFromTypeNode(baseNode)
    const keyNode = typeArgs[1]
    const keyType = keyNode ? checker.getTypeFromTypeNode(keyNode) : null
    const keys = keyType ? extractStringLiterals(keyType) : []
    if (name === 'Pick' && keys.length && !keys.includes(propName))
      return null
    if (name === 'Omit' && keys.includes(propName))
      return null
    return resolvePropTypeFromTypeDecls(baseType, checker, propName, seen)
  }

  if (name === 'Partial' || name === 'Required' || name === 'Readonly') {
    const baseNode = typeArgs[0]
    if (!baseNode)
      return null
    const baseType = checker.getTypeFromTypeNode(baseNode)
    return resolvePropTypeFromTypeDecls(baseType, checker, propName, seen)
  }

  const baseType = checker.getTypeAtLocation(node)
  return baseType ? resolvePropTypeFromTypeDecls(baseType, checker, propName, seen) : null
}

function getMappedTypeProps(type: ts.Type, checker: ts.TypeChecker, seen: Set<ts.Type>) {
  const ref = getTypeReference(type) || getTypeReference(checker.getApparentType(type))
  const aliasName = type.aliasSymbol?.getName() || ref?.target?.symbol?.getName()
  const args = type.aliasTypeArguments || (ref ? checker.getTypeArguments(ref) : [])
  if (!aliasName || !args?.length)
    return null
  const baseType = args?.[0]
  if (!baseType)
    return null

  const baseProps = getPropsFromType(baseType, checker, seen)
  if (!baseProps.length)
    return null

  if (aliasName === 'Omit' || aliasName === 'Pick') {
    const keyType = args?.[1]
    const keys = keyType ? extractStringLiterals(keyType) : []
    if (!keys.length)
      return aliasName === 'Pick' ? baseProps : baseProps
    const keySet = new Set(keys)
    return aliasName === 'Pick'
      ? baseProps.filter(p => keySet.has(getSymbolName(p)))
      : baseProps.filter(p => !keySet.has(getSymbolName(p)))
  }

  if (aliasName === 'Partial' || aliasName === 'Required' || aliasName === 'Readonly') {
    return baseProps
  }

  return null
}

function getPropsFromType(type: ts.Type, checker: ts.TypeChecker, seen: Set<ts.Type>) {
  const map = new Map<string, ts.Symbol>()
  collectPropSymbols(type, checker, map, seen)
  return [...map.values()]
}

function getHeritageTypeName(node: ts.ExpressionWithTypeArguments | ts.TypeReferenceNode) {
  if (ts.isExpressionWithTypeArguments(node)) {
    const expr = node.expression
    if (ts.isIdentifier(expr))
      return expr.text
    if (ts.isPropertyAccessExpression(expr))
      return expr.name.text
  }
  else if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName
    if (ts.isIdentifier(name))
      return name.text
    if (ts.isQualifiedName(name))
      return name.right.text
  }
  return ''
}

function collectPropsFromHeritageTypeNode(
  node: ts.ExpressionWithTypeArguments | ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  out: Map<string, ts.Symbol>,
  seen: Set<ts.Type>,
) {
  const name = getHeritageTypeName(node)
  const typeArgs = (ts.isExpressionWithTypeArguments(node) ? node.typeArguments : node.typeArguments) || []
  if (!name || !typeArgs.length)
    return false

  if (name === 'Omit' || name === 'Pick') {
    const baseNode = typeArgs[0]
    if (!baseNode)
      return true
    const baseType = checker.getTypeFromTypeNode(baseNode)
    const baseProps = getPropsFromType(baseType, checker, seen)
    if (!baseProps.length)
      return true
    const keyNode = typeArgs[1]
    const keyType = keyNode ? checker.getTypeFromTypeNode(keyNode) : null
    const keys = keyType ? extractStringLiterals(keyType) : []
    const keySet = new Set(keys)
    const filtered = name === 'Pick'
      ? baseProps.filter(p => keySet.has(getSymbolName(p)))
      : keys.length
        ? baseProps.filter(p => !keySet.has(getSymbolName(p)))
        : baseProps
    for (const prop of filtered)
      out.set(prop.getName(), prop)
    return true
  }

  if (name === 'Partial' || name === 'Required' || name === 'Readonly') {
    const baseNode = typeArgs[0]
    if (!baseNode)
      return true
    const baseType = checker.getTypeFromTypeNode(baseNode)
    const baseProps = getPropsFromType(baseType, checker, seen)
    for (const prop of baseProps)
      out.set(prop.getName(), prop)
    return true
  }

  return false
}

function extractLiteralUnion(type: ts.Type, checker: ts.TypeChecker) {
  if (!type.isUnion())
    return
  const literals = type.types.map((t) => {
    if (t.isStringLiteral())
      return t.value
    if (t.isNumberLiteral())
      return String(t.value)
    if (t.flags & ts.TypeFlags.BooleanLiteral)
      return checker.typeToString(t)
    return null
  }).filter(Boolean) as string[]
  if (!literals.length || literals.length !== type.types.length)
    return
  return literals
}

function extractLiteralValuesFromType(type: ts.Type, checker: ts.TypeChecker) {
  const values: string[] = []
  if (type.isStringLiteral()) {
    values.push(type.value)
  }
  else if (type.isNumberLiteral()) {
    values.push(String(type.value))
  }
  else if (type.flags & ts.TypeFlags.BooleanLiteral) {
    values.push(checker.typeToString(type))
  }
  else if (type.isUnion()) {
    for (const part of type.types) {
      if (part.isStringLiteral())
        values.push(part.value)
      else if (part.isNumberLiteral())
        values.push(String(part.value))
      else if (part.flags & ts.TypeFlags.BooleanLiteral)
        values.push(checker.typeToString(part))
    }
  }
  return values
}

function isSimpleIdentifier(text: string) {
  return /^[A-Z_$][\w$]*$/i.test(text.trim())
}

function isPrimitiveType(text: string) {
  const value = text.trim()
  return value === 'string'
    || value === 'number'
    || value === 'boolean'
    || value === 'bigint'
    || value === 'symbol'
}

function formatLiteralValue(value: string, baseType?: string) {
  const trimmed = value.trim()
  if (baseType === 'number' || baseType === 'bigint')
    return trimmed
  if (baseType === 'boolean') {
    if (trimmed === 'true' || trimmed === 'false')
      return trimmed
    return `'${trimmed.replace(/'/g, '\\\'')}'`
  }
  if (trimmed.startsWith('"') || trimmed.startsWith('\''))
    return trimmed
  return `'${trimmed.replace(/'/g, '\\\'')}'`
}

function buildLiteralUnionString(values: string[], baseType?: string) {
  const unique = [...new Set(values)].filter(Boolean)
  if (!unique.length)
    return ''
  return unique.map(value => formatLiteralValue(value, baseType)).join(' | ')
}

function stripUndefinedFromUnion(text: string) {
  const parts = text.split('|').map(part => part.trim()).filter(Boolean)
  if (!parts.length)
    return text
  const filtered = parts.filter(part => part !== 'undefined')
  return filtered.length ? filtered.join(' | ') : text
}

function stripArrayWrappers(text: string) {
  let value = text.trim()
  while (value.endsWith('[]'))
    value = value.slice(0, -2).trim()
  const readonlyMatch = /^ReadonlyArray<(.+)>$/.exec(value)
  if (readonlyMatch)
    return stripArrayWrappers(readonlyMatch[1])
  return value
}

function isWeakTypeString(text: string) {
  const raw = text?.trim()
  if (!raw)
    return true
  if (raw === '{}' || raw === 'object')
    return true
  const parts = raw.split('|').map(part => part.trim()).filter(Boolean)
  if (!parts.length)
    return true
  const nonNullable = parts.filter(part => part !== 'null' && part !== 'undefined')
  if (!nonNullable.length)
    return true
  return nonNullable.every((part) => {
    const base = stripArrayWrappers(part)
    return base === '{}' || base === 'object'
  })
}

function isAliasLikeType(text: string) {
  const base = stripArrayWrappers(text)
  if (!base)
    return false
  if (base.includes('{') || base.includes('|') || base.includes('&'))
    return false
  if (!/^[A-Z_$][\w$]*(?:<.*>)?$/i.test(base))
    return false
  if (isPrimitiveType(base) || ['any', 'unknown', 'void', 'null', 'undefined'].includes(base))
    return false
  return true
}

function expandTypeNodeForDisplay(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  context: ts.Node,
  depth = 0,
  seen = new Set<ts.Type>(),
): string | null {
  if (depth > MAX_INLINE_TYPE_DEPTH)
    return null

  if (ts.isParenthesizedTypeNode(node))
    return expandTypeNodeForDisplay(node.type, checker, context, depth + 1, seen)

  if (ts.isArrayTypeNode(node)) {
    const inner = expandTypeNodeForDisplay(node.elementType, checker, context, depth + 1, seen)
      || cleanTypeText(node.elementType.getText())
    const text = `${inner}[]`
    return text.length <= MAX_INLINE_TYPE_LENGTH ? text : null
  }

  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const parts: string[] = []
    for (const part of node.types) {
      if (parts.length >= MAX_INLINE_UNION_MEMBERS)
        return null
      const expanded = expandTypeNodeForDisplay(part, checker, context, depth + 1, seen)
      const partText = expanded || cleanTypeText(part.getText())
      parts.push(partText)
    }
    const glue = ts.isUnionTypeNode(node) ? ' | ' : ' & '
    const joined = parts.join(glue)
    return joined.length <= MAX_INLINE_TYPE_LENGTH ? joined : null
  }

  if (ts.isTypeLiteralNode(node)) {
    const members = node.members.filter(m => ts.isPropertySignature(m) && m.name)
    if (!members.length || members.length > MAX_INLINE_TYPE_PROPS)
      return null
    const parts = members.map((member) => {
      const name = member.name && ts.isIdentifier(member.name)
        ? member.name.text
        : member.name && (ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))
          ? member.name.text
          : ''
      if (!name)
        return ''
      const optional = !!member.questionToken
      let propText = member.type
        ? (expandTypeNodeForDisplay(member.type, checker, context, depth + 1, seen) || cleanTypeText(member.type.getText()))
        : 'any'
      if (optional)
        propText = stripUndefinedFromUnion(propText)
      return `${name}${optional ? '?' : ''}: ${propText}`
    }).filter(Boolean)
    if (!parts.length)
      return null
    const inline = `{ ${parts.join('; ')} }`
    return inline.length <= MAX_INLINE_TYPE_LENGTH ? inline : null
  }

  if (ts.isTypeReferenceNode(node)) {
    const name = getHeritageTypeName(node)
    const typeArgs = node.typeArguments || []
    if (name && typeArgs.length && (name === 'Omit' || name === 'Pick' || name === 'Partial' || name === 'Required' || name === 'Readonly')) {
      const baseNode = typeArgs[0]
      if (baseNode) {
        const baseType = checker.getTypeFromTypeNode(baseNode)
        const baseProps = getPropsFromType(baseType, checker, new Set(seen))
        if (baseProps.length && baseProps.length <= MAX_INLINE_TYPE_PROPS) {
          let filtered = baseProps
          if (name === 'Omit' || name === 'Pick') {
            const keyNode = typeArgs[1]
            const keyType = keyNode ? checker.getTypeFromTypeNode(keyNode) : null
            const keys = keyType ? extractStringLiterals(keyType) : []
            const keySet = new Set(keys)
            filtered = name === 'Pick'
              ? baseProps.filter(p => keySet.has(getSymbolName(p)))
              : keys.length
                ? baseProps.filter(p => !keySet.has(getSymbolName(p)))
                : baseProps
          }
          if (filtered.length && filtered.length <= MAX_INLINE_TYPE_PROPS) {
            const forceOptional = name === 'Partial'
            const forceRequired = name === 'Required'
            const parts = filtered.map((prop) => {
              const propName = getSymbolName(prop)
              const optional = forceOptional
                ? true
                : forceRequired
                  ? false
                  : (prop.getFlags() & ts.SymbolFlags.Optional) !== 0
              const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration || context)
              let propText = expandTypeForDisplay(propType, checker, prop.valueDeclaration || context, depth + 1, seen)
                || cleanTypeText(checker.typeToString(propType, context, ts.TypeFormatFlags.NoTruncation))
              if (optional)
                propText = stripUndefinedFromUnion(propText)
              return `${propName}${optional ? '?' : ''}: ${propText}`
            })
            const inline = `{ ${parts.join('; ')} }`
            return inline.length <= MAX_INLINE_TYPE_LENGTH ? inline : null
          }
        }
      }
    }

    const type = checker.getTypeFromTypeNode(node)
    return expandTypeForDisplay(type, checker, context, depth + 1, seen)
  }

  return null
}

function expandTypeForDisplay(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ts.Node,
  depth = 0,
  seen = new Set<ts.Type>(),
): string | null {
  if (depth > MAX_INLINE_TYPE_DEPTH)
    return null
  if (seen.has(type))
    return null
  seen.add(type)

  const apparent = checker.getApparentType(type)

  if (apparent.isUnion() || apparent.isIntersection()) {
    const parts: string[] = []
    for (const part of apparent.types) {
      if (parts.length >= MAX_INLINE_UNION_MEMBERS)
        return null
      const expanded = expandTypeForDisplay(part, checker, context, depth + 1, seen)
      const partText = expanded || cleanTypeText(checker.typeToString(part, context, ts.TypeFormatFlags.NoTruncation))
      parts.push(partText)
    }
    const glue = apparent.isUnion() ? ' | ' : ' & '
    const joined = parts.join(glue)
    return joined.length <= MAX_INLINE_TYPE_LENGTH ? joined : null
  }

  if (checker.isArrayType(apparent) || checker.isTupleType(apparent)) {
    const element = getArrayElementType(apparent, checker)
    if (!element)
      return null
    const inner = expandTypeForDisplay(element, checker, context, depth + 1, seen)
      || cleanTypeText(checker.typeToString(element, context, ts.TypeFormatFlags.NoTruncation))
    const arrayText = `${inner}[]`
    return arrayText.length <= MAX_INLINE_TYPE_LENGTH ? arrayText : null
  }

  const mapped = expandMappedTypeForDisplay(type, checker, context, depth + 1, seen)
    || expandMappedTypeForDisplay(apparent, checker, context, depth + 1, seen)
  if (mapped)
    return mapped.length <= MAX_INLINE_TYPE_LENGTH ? mapped : null

  if (isObjectLikeType(apparent, checker)) {
    const namedSymbol = apparent.symbol || type.aliasSymbol || type.symbol
    const typeName = namedSymbol?.getName()
    if (typeName && !typeName.startsWith('__'))
      return null
    const props = apparent.getProperties().filter(p => isRenderablePropName(getSymbolName(p)))
    if (!props.length || props.length > MAX_INLINE_TYPE_PROPS)
      return null
    const parts = props.map((prop) => {
      const name = getSymbolName(prop)
      const optional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0
      const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration || context)
      let propText = expandTypeForDisplay(propType, checker, prop.valueDeclaration || context, depth + 1, seen)
        || cleanTypeText(checker.typeToString(propType, context, ts.TypeFormatFlags.NoTruncation))
      if (optional)
        propText = stripUndefinedFromUnion(propText)
      return `${name}${optional ? '?' : ''}: ${propText}`
    })
    const inline = `{ ${parts.join('; ')} }`
    return inline.length <= MAX_INLINE_TYPE_LENGTH ? inline : null
  }

  return null
}

function expandMappedTypeForDisplay(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ts.Node,
  depth = 0,
  seen = new Set<ts.Type>(),
) {
  const ref = getTypeReference(type) || getTypeReference(checker.getApparentType(type))
  const aliasName = type.aliasSymbol?.getName() || ref?.target?.symbol?.getName()
  const args = type.aliasTypeArguments || (ref ? checker.getTypeArguments(ref) : [])
  if (!aliasName || !args?.length)
    return null
  const baseType = args?.[0]
  if (!baseType)
    return null

  const baseProps = getPropsFromType(baseType, checker, new Set(seen))
  if (!baseProps.length)
    return null

  let filtered = baseProps
  if (aliasName === 'Omit' || aliasName === 'Pick') {
    const keyType = args?.[1]
    const keys = keyType ? extractStringLiterals(keyType) : []
    const keySet = new Set(keys)
    filtered = aliasName === 'Pick'
      ? baseProps.filter(p => keySet.has(getSymbolName(p)))
      : keys.length
        ? baseProps.filter(p => !keySet.has(getSymbolName(p)))
        : baseProps
  }
  else if (aliasName !== 'Partial' && aliasName !== 'Required' && aliasName !== 'Readonly') {
    return null
  }

  if (!filtered.length || filtered.length > MAX_INLINE_TYPE_PROPS)
    return null

  const forceOptional = aliasName === 'Partial'
  const forceRequired = aliasName === 'Required'
  const parts = filtered.map((prop) => {
    const name = getSymbolName(prop)
    const optional = forceOptional
      ? true
      : forceRequired
        ? false
        : (prop.getFlags() & ts.SymbolFlags.Optional) !== 0
    const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration || context)
    let propText = expandTypeForDisplay(propType, checker, prop.valueDeclaration || context, depth + 1, seen)
      || cleanTypeText(checker.typeToString(propType, context, ts.TypeFormatFlags.NoTruncation))
    if (optional)
      propText = stripUndefinedFromUnion(propText)
    return `${name}${optional ? '?' : ''}: ${propText}`
  })
  return `{ ${parts.join('; ')} }`
}

function formatPropType(
  type: ts.Type,
  checker: ts.TypeChecker,
  decl: ts.Node,
  declInfo?: { text?: string, rawText?: string, literals?: string[], expandedText?: string },
  stripUndefined = false,
) {
  const apparent = checker.getApparentType(type)
  const rawTypeString = cleanTypeText(checker.typeToString(type, decl, ts.TypeFormatFlags.NoTruncation))
  const expandedFromType = expandTypeForDisplay(type, checker, decl)
  const aliasInfo = (!declInfo?.text && !declInfo?.literals?.length)
    ? resolveTypeInfoFromType(type, checker, decl)
    : undefined
  const mergedInfo = (declInfo?.text || declInfo?.literals?.length) ? declInfo : aliasInfo
  const declText = mergedInfo?.text ? cleanTypeText(mergedInfo.text) : ''
  const rawDeclText = mergedInfo?.rawText ? cleanTypeText(mergedInfo.rawText) : ''
  const declExpanded = mergedInfo?.expandedText ? cleanTypeText(mergedInfo.expandedText) : ''
  const expandedType = (!expandedFromType || expandedFromType === '{}' || expandedFromType === 'object')
    ? (declExpanded || expandedFromType)
    : expandedFromType
  let literalValues = mergedInfo?.literals?.length
    ? mergedInfo.literals
    : []
  if (!literalValues.length && declText)
    literalValues = extractLiteralValuesFromText(declText)
  if (!literalValues.length)
    literalValues = extractLiteralValuesFromType(apparent, checker)
  const baseTypeHint = isPrimitiveType(declText)
    ? declText.trim()
    : (isPrimitiveType(rawTypeString) ? rawTypeString.trim() : undefined)
  const literalUnion = literalValues.length ? buildLiteralUnionString(literalValues, baseTypeHint) : ''
  const shouldPreferLiteralUnion = !!literalUnion && (
    isSimpleIdentifier(declText || rawTypeString)
    || isPrimitiveType(declText || rawTypeString)
    || !(declText || rawTypeString)
    || (isPrimitiveType(rawTypeString) && !isPrimitiveType(declText))
  )

  if (!apparent.isUnion()) {
    let typeString = expandedType || declText || rawTypeString
    if (!expandedType && rawDeclText && (typeString === '{}' || typeString.includes('{}') || /\bString\b|\bNumber\b|\bBoolean\b/.test(typeString)))
      typeString = rawDeclText
    if (shouldPreferLiteralUnion) {
      const baseType = isPrimitiveType(typeString)
        ? typeString.trim()
        : (isPrimitiveType(rawTypeString) ? rawTypeString.trim() : '')
      typeString = baseType ? `${literalUnion} | ${baseType}` : literalUnion
    }
    if (stripUndefined)
      typeString = stripUndefinedFromUnion(typeString)
    const value = literalValues.length
      ? literalValues
      : (extractLiteralUnion(apparent, checker) ?? typeString)
    if (
      Array.isArray(value)
      && value.length
      && !typeString.includes('|')
      && isPrimitiveType(typeString)
      && value.every(v => ['string', 'number', 'boolean'].includes(typeof v))
    ) {
      const literalUnion = buildLiteralUnionString(value.map(v => String(v)), typeString.trim())
      if (literalUnion)
        typeString = `${literalUnion} | ${typeString.trim()}`
    }
    return { typeString, value }
  }

  const literalStrings = new Set<string>()
  const literalNumbers = new Set<string>()
  const typeParts: string[] = []
  for (const part of apparent.types) {
    if (stripUndefined && (part.flags & ts.TypeFlags.Undefined))
      continue
    if (part.isStringLiteral()) {
      literalStrings.add(part.value)
      typeParts.push(checker.typeToString(part, decl, ts.TypeFormatFlags.NoTruncation))
      continue
    }
    if (part.isNumberLiteral()) {
      literalNumbers.add(String(part.value))
      typeParts.push(checker.typeToString(part, decl, ts.TypeFormatFlags.NoTruncation))
      continue
    }
    if (part.flags & ts.TypeFlags.String) {
      typeParts.push('string')
      continue
    }
    if (part.flags & ts.TypeFlags.Number) {
      typeParts.push('number')
      continue
    }
    if (part.flags & ts.TypeFlags.Boolean) {
      typeParts.push('boolean')
      continue
    }
    typeParts.push(checker.typeToString(part, decl, ts.TypeFormatFlags.NoTruncation))
  }

  const deduped = [...new Set(typeParts.filter(Boolean))]
  const unionString = cleanTypeText((deduped.join(' | ') || rawTypeString))
  let typeString = expandedType || declText || unionString
  if (!expandedType && rawDeclText && (typeString === '{}' || typeString.includes('{}') || /\bString\b|\bNumber\b|\bBoolean\b/.test(typeString)))
    typeString = rawDeclText
  if (shouldPreferLiteralUnion && literalUnion)
    typeString = literalUnion
  if (stripUndefined)
    typeString = stripUndefinedFromUnion(typeString)
  const value = literalValues.length
    ? literalValues
    : literalStrings.size
      ? [...literalStrings]
      : literalNumbers.size
        ? [...literalNumbers]
        : typeString

  if (
    Array.isArray(value)
    && value.length
    && !typeString.includes('|')
    && isPrimitiveType(typeString)
    && value.every(v => ['string', 'number', 'boolean'].includes(typeof v))
  ) {
    const literalUnion = buildLiteralUnionString(value.map(v => String(v)), typeString.trim())
    if (literalUnion)
      typeString = `${literalUnion} | ${typeString.trim()}`
  }

  return { typeString, value }
}

function buildTypeDetailFromProp(prop: ts.Symbol, propType: ts.Type, checker: ts.TypeChecker, context: ts.Node) {
  const decl = prop.valueDeclaration || prop.declarations?.[0]
  let targetType: ts.Type | undefined
  if (decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type) {
    targetType = resolveTypeFromNodeForDetail(decl.type, checker, decl)
  }
  if (!targetType)
    targetType = propType

  const detailMap = new Map<string, typeDetailItem[]>()
  const seen = new Set<ts.Symbol>()
  collectTypeDetail(targetType, checker, context, detailMap, 0, seen, prop.getName())
  if (!detailMap.size)
    return
  return Object.fromEntries(detailMap) as typeDetail
}

function resolveTypeFromNodeForDetail(node: ts.TypeNode, checker: ts.TypeChecker, context: ts.Node) {
  if (ts.isIndexedAccessTypeNode(node)) {
    const names = getIndexAccessNames(node.indexType)
    if (names.length === 1) {
      const objectType = checker.getTypeFromTypeNode(node.objectType)
      const objectApparent = checker.getApparentType(objectType)
      const prop = objectApparent.getProperty(names[0]) || objectType.getProperty(names[0])
      if (prop)
        return checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration || context)
    }
  }
  return checker.getTypeFromTypeNode(node)
}

function collectTypeDetail(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ts.Node,
  out: Map<string, typeDetailItem[]>,
  depth = 0,
  seen = new Set<ts.Symbol>(),
  fallbackName = '',
) {
  if (depth > MAX_TYPE_DETAIL_DEPTH)
    return
  const apparent = checker.getApparentType(type)

  if (apparent.isUnion()) {
    const members = apparent.types.filter(t => isObjectLikeType(t, checker))
    if (!members.length)
      return
    const unionName = cleanTypeName((apparent.aliasSymbol || apparent.symbol)?.getName() || fallbackName || `Union${depth}`)
    const unionKey = `$${unionName || `Union${depth}`}`
    const unionItems: typeDetailItem[] = []
    let count = 0
    for (const member of members) {
      if (count >= MAX_TYPE_DETAIL_UNION_MEMBERS)
        break
      const memberName = cleanTypeName((member.aliasSymbol || member.symbol)?.getName() || `Type${count + 1}`)
      const description = cleanTypeText(checker.typeToString(member, context, ts.TypeFormatFlags.NoTruncation))
      unionItems.push({ name: memberName, description })
      collectTypeDetail(member, checker, context, out, depth + 1, seen, memberName)
      count += 1
    }
    if (unionItems.length)
      mergeTypeDetail(out, unionKey, unionItems)
    return
  }

  if (apparent.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    return
  if (checker.isArrayType(apparent) || checker.isTupleType(apparent)) {
    const element = getArrayElementType(apparent, checker)
    if (element)
      collectTypeDetail(element, checker, context, out, depth + 1, seen, fallbackName)
    return
  }
  if (apparent.getCallSignatures().length)
    return

  const symbol = apparent.aliasSymbol || apparent.symbol
  const rawName = symbol?.getName() || fallbackName || ''
  const name = cleanTypeName(rawName)
  if (!name)
    return
  if (symbol && seen.has(symbol))
    return
  if (symbol)
    seen.add(symbol)

  const props = apparent.getProperties()
  if (!props.length)
    return

  const items: typeDetailItem[] = []
  for (const prop of props) {
    const propName = getSymbolName(prop)
    if (!propName || propName.startsWith('$') || propName.startsWith('_'))
      continue
    const propDecl = prop.valueDeclaration || prop.declarations?.[0]
    const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl || context)
    const info = resolveTypeInfoFromType(propType, checker, context, 0, new Set())
    const typeText = info.text || cleanTypeText(checker.typeToString(propType, context, ts.TypeFormatFlags.NoTruncation))
    const description = ts.displayPartsToString(prop.getDocumentationComment(checker))
    const optional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0
      || (propDecl && (ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)) && !!propDecl.questionToken)
    items.push({
      name: propName,
      type: typeText,
      description,
      optional,
    })
    if (items.length >= MAX_TYPE_DETAIL_MEMBERS)
      break

    if (depth < MAX_TYPE_DETAIL_DEPTH) {
      const nested = checker.getApparentType(propType)
      const nestedSymbol = nested.aliasSymbol || nested.symbol
      if (nestedSymbol && !seen.has(nestedSymbol)) {
        const nestedProps = nested.getProperties()
        if (nestedProps.length)
          collectTypeDetail(propType, checker, context, out, depth + 1, seen, propName)
      }
    }
  }

  if (items.length)
    mergeTypeDetail(out, name, items)
}

function cleanTypeName(name: string) {
  return name.replace(/\$\d+$/g, '')
}

function mergeTypeDetail(out: Map<string, typeDetailItem[]>, name: string, items: typeDetailItem[]) {
  if (!items.length)
    return
  const existing = out.get(name)
  if (!existing) {
    out.set(name, items)
    return
  }
  const map = new Map<string, typeDetailItem>()
  for (const item of existing) {
    if (item.name)
      map.set(item.name, item)
  }
  for (const item of items) {
    if (item.name && !map.has(item.name))
      map.set(item.name, item)
  }
  out.set(name, [...map.values()])
}

function isObjectLikeType(type: ts.Type, checker: ts.TypeChecker) {
  const apparent = checker.getApparentType(type)
  if (apparent.isUnion() || apparent.isIntersection())
    return false
  if (apparent.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    return false
  if (checker.isArrayType(apparent) || checker.isTupleType(apparent))
    return false
  if (apparent.getCallSignatures().length)
    return false
  return apparent.getProperties().length > 0
}

function getTypeInfoFromDecl(symbol: ts.Symbol, checker: ts.TypeChecker) {
  const candidates: ts.Declaration[] = []
  if (symbol.valueDeclaration)
    candidates.push(symbol.valueDeclaration)
  if (symbol.declarations?.length)
    candidates.push(...symbol.declarations)
  for (const decl of candidates) {
    if (decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type) {
      const resolved = resolveTypeInfoFromNode(decl.type, checker, decl)
      const rawText = decl.type.getText()
      const expandedText = expandTypeNodeForDisplay(decl.type, checker, decl)
      return {
        text: resolved.text || rawText,
        rawText,
        literals: resolved.literals,
        expandedText,
      }
    }
  }
  return {} as { text?: string, rawText?: string, literals?: string[], expandedText?: string }
}

function resolveTypeInfoFromNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  context: ts.Node,
  depth = 0,
  seen = new Set<ts.Symbol>(),
) {
  if (depth > MAX_TYPE_DEPTH)
    return {} as { text?: string, literals?: string[] }

  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal))
      return { text: node.getText(), literals: [node.literal.text] }
    if (ts.isNumericLiteral(node.literal))
      return { text: node.getText(), literals: [node.literal.text] }
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword)
      return { text: 'true', literals: ['true'] }
    if (node.literal.kind === ts.SyntaxKind.FalseKeyword)
      return { text: 'false', literals: ['false'] }
  }

  if (ts.isIndexedAccessTypeNode(node)) {
    const info = resolveIndexedAccessInfo(node, checker, context, depth + 1, seen)
    if (info.text || info.literals?.length)
      return info
  }

  if (ts.isTypeReferenceNode(node)) {
    const aliasInfo = resolveTypeAliasInfo(node, checker, depth + 1, seen)
    if (aliasInfo.text || aliasInfo.literals?.length)
      return aliasInfo
  }

  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const parts: string[] = []
    const literals: string[] = []
    for (const part of node.types) {
      const info = resolveTypeInfoFromNode(part, checker, context, depth + 1, seen)
      if (info.text)
        parts.push(info.text)
      if (info.literals?.length)
        literals.push(...info.literals)
    }
    const glue = ts.isUnionTypeNode(node) ? ' | ' : ' & '
    return {
      text: parts.length ? cleanTypeText(parts.join(glue)) : node.getText(),
      literals: [...new Set(literals)],
    }
  }

  const type = checker.getTypeFromTypeNode(node)
  return resolveTypeInfoFromType(type, checker, context, depth + 1, seen)
}

function resolveIndexedAccessInfo(
  node: ts.IndexedAccessTypeNode,
  checker: ts.TypeChecker,
  context: ts.Node,
  depth = 0,
  seen = new Set<ts.Symbol>(),
) {
  if (depth > MAX_TYPE_DEPTH)
    return {} as { text?: string, literals?: string[] }
  const objectType = checker.getTypeFromTypeNode(node.objectType)
  const objectApparent = checker.getApparentType(objectType)
  const names = getIndexAccessNames(node.indexType)
  if (!names.length)
    return {} as { text?: string, literals?: string[] }

  const texts: string[] = []
  const literals: string[] = []
  for (const name of names) {
    const prop = objectApparent.getProperty(name) || objectType.getProperty(name)
    if (!prop)
      continue
    const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration || context)
    const info = resolveTypeInfoFromType(propType, checker, context, depth + 1, seen)
    if (info.text)
      texts.push(info.text)
    if (info.literals?.length)
      literals.push(...info.literals)
  }

  if (!texts.length && !literals.length)
    return {} as { text?: string, literals?: string[] }

  return {
    text: texts.length ? cleanTypeText([...new Set(texts)].join(' | ')) : undefined,
    literals: literals.length ? [...new Set(literals)] : undefined,
  }
}

function getIndexAccessNames(node: ts.TypeNode) {
  const names: string[] = []
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    names.push(node.literal.text)
    return names
  }
  if (ts.isUnionTypeNode(node)) {
    for (const part of node.types) {
      if (ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal))
        names.push(part.literal.text)
    }
  }
  return names
}

function resolveTypeAliasInfo(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Symbol>(),
) {
  if (depth > MAX_TYPE_DEPTH)
    return {} as { text?: string, literals?: string[] }
  const symbol = checker.getSymbolAtLocation(node.typeName)
  if (!symbol)
    return {} as { text?: string, literals?: string[] }
  const aliased = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol
  if (seen.has(aliased))
    return {} as { text?: string, literals?: string[] }
  seen.add(aliased)
  const aliasDecl = aliased.declarations?.find(d => ts.isTypeAliasDeclaration(d)) as ts.TypeAliasDeclaration | undefined
  if (!aliasDecl)
    return {} as { text?: string, literals?: string[] }
  return resolveTypeInfoFromNode(aliasDecl.type, checker, aliasDecl, depth + 1, seen)
}

function resolveTypeInfoFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ts.Node,
  depth = 0,
  seen = new Set<ts.Symbol>(),
) {
  if (depth > MAX_TYPE_DEPTH)
    return {} as { text?: string, literals?: string[] }
  const apparent = checker.getApparentType(type)

  if (apparent.isUnion() || apparent.isIntersection()) {
    const parts: string[] = []
    const literals: string[] = []
    for (const part of apparent.types) {
      const info = resolveTypeInfoFromType(part, checker, context, depth + 1, seen)
      if (info.text)
        parts.push(info.text)
      if (info.literals?.length)
        literals.push(...info.literals)
    }
    const glue = apparent.isUnion() ? ' | ' : ' & '
    const text = parts.length
      ? cleanTypeText([...new Set(parts)].join(glue))
      : cleanTypeText(checker.typeToString(apparent, context, ts.TypeFormatFlags.NoTruncation))
    const literalValues = literals.length
      ? [...new Set(literals)]
      : extractLiteralValuesFromType(apparent, checker)
    return { text, literals: literalValues }
  }

  const symbol = apparent.aliasSymbol || apparent.symbol
  if (symbol) {
    const aliased = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol
    if (!seen.has(aliased)) {
      seen.add(aliased)
      const aliasDecl = aliased.declarations?.find(d => ts.isTypeAliasDeclaration(d)) as ts.TypeAliasDeclaration | undefined
      if (aliasDecl) {
        const info = resolveTypeInfoFromNode(aliasDecl.type, checker, aliasDecl, depth + 1, seen)
        if (info.text || info.literals?.length)
          return info
      }
    }
  }

  return {
    text: cleanTypeText(checker.typeToString(apparent, context, ts.TypeFormatFlags.NoTruncation)),
    literals: extractLiteralValuesFromType(apparent, checker),
  }
}

function extractLiteralValuesFromText(text: string) {
  const values = new Set<string>()
  const regex = /'([^']+)'|"([^"]+)"/g
  for (const match of text.matchAll(regex)) {
    const value = match[1] ?? match[2]
    if (value)
      values.add(value)
  }
  return [...values]
}

function cleanTypeText(text: string) {
  return text
    .replace(/typeof\s+import\([^)]*\)\.?/g, '')
    .replace(/import\((?:"[^"]+"|'[^']+'|[^)]+)\)\./g, '')
    .replace(/import\((?:"[^"]+"|'[^']+'|[^)]+)\)/g, '')
    .replace(/\b([A-Z_$][\w$]*)\$\d+\b/gi, '$1')
    .replace(/\bString\b/g, 'string')
    .replace(/\bNumber\b/g, 'number')
    .replace(/\bBoolean\b/g, 'boolean')
    .replace(/\bBigInt\b/g, 'bigint')
    .replace(/\bSymbol\b/g, 'symbol')
    .replace(/\s+/g, ' ')
    .trim()
}

function getMemberName(name: ts.PropertyName) {
  if (ts.isIdentifier(name))
    return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text
  return null
}

function isComponentName(name: string) {
  if (!name || name === 'default')
    return false
  const first = name[0]
  return first.toUpperCase() === first && first.toLowerCase() !== first
}

function isComponentLike(type: ts.Type) {
  return type.getConstructSignatures().length > 0 || type.getCallSignatures().length > 0
}
