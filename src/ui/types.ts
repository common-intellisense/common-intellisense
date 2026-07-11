import type * as vscode from 'vscode'
import type { CompletionRenderContext } from './utils'

export interface DocumentEditIdentity {
  uri: string
  version: number
}

export interface PropsConfig { [key: string]: any }

export interface ComponentItem {
  prefix: string
  data: ((parent?: any, context?: CompletionRenderContext) => vscode.CompletionItem[])[]
  directives?: Record<string, any>
  lib: string
}

export type ComponentsConfig = ComponentItem[]

export type Directives = Record<string, any>

export interface OptionsComponents {
  prefix: string[]
  data: ((parent?: any, context?: CompletionRenderContext) => vscode.CompletionItem[])[]
  directivesMap: Record<string, Directives | undefined>
  libs: string[]
}

export type Uis = [string, string][]
