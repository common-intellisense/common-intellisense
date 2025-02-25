export interface PropsItem {
  default: any
  value: any
  type?: string
  version?: string
  description?: string
  description_zh?: string
  required?: boolean
}

export type Props = Record<string, PropsItem>

export interface EventItem {
  name: string
  description?: string
  description_zh?: string
  params?: string | any[]
  value?: string
}
export type Events = EventItem[]

export interface MethodItem {
  name: string
  description?: string
  description_zh?: string
  params?: string
  value?: string
}
export type Methods = MethodItem[]

export interface SlotItem {
  name?: string
  description?: string
  description_zh?: string
  params?: string
  version?: string
}
export type Slots = SlotItem[]

export interface ExposedItem {
  name: string
  description?: string
  description_zh?: string
  detail: string
}
export type Exposed = ExposedItem[]

export interface typeDetailItem {
  name?: string
  description?: string
  type?: string
  description_zh?: string
  params?: string
  value?: string
  default?: any
  [key: string]: any
}

export type typeDetail = Record<string, string | typeDetailItem[]>

export interface SuggestionItem {
  name: string
  description: string
  description_zh: string
}

export interface Component {
  name: string
  description?: string
  description_zh?: string
  tag?: string
  props: Props
  events: Events
  methods: Methods
  slots?: Slots
  exposed?: Exposed
  suggestions?: (string | SuggestionItem)[]
  typeDetail?: typeDetail
  link?: string
  link_zh?: string
  dynamicLib?: string
  importWay?: 'as default' | 'default' | 'specifier'
  version?: string
}
