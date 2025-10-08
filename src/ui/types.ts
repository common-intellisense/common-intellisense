import type * as vscode from 'vscode'

export interface PropsConfig { [key: string]: any }

export interface ComponentItem {
  prefix: string
  data: ((parent?: any) => vscode.CompletionItem[])[]
  directives?: Record<string, any>
  lib: string
}

export type ComponentsConfig = ComponentItem[]

export type Directives = Record<string, any>

export interface OptionsComponents {
  prefix: string[]
  data: ((parent?: any) => vscode.CompletionItem[])[]
  directivesMap: Record<string, Directives | undefined>
  libs: string[]
}

export type Uis = [string, string][]
