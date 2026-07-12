<p align="center">
<img height="200" src="./assets/kv.png" alt="common-intellisense">
</p>
<p align="center"> <a href="https://github.com/Simon-He95/vscode-common-intellisense/blob/main/README.md">English</a> | 简体中文</p>

此插件能够提供超级强大的智能提示功能，包含属性、事件、插槽以及对应的注释和类型，实例上的方法等等，支持多个 UI 库，让你的开发效率更上一层楼。

### 🛠️️ 如何使用
在你的项目中安装已支持的 ui 组件库并安装此插件即可。如果插件不能生效，可以重启 vscode，如遇到问题可以打开一个 [issue](https://github.com/common-intellisense/common-intellisense/issues/new)

### 🍬 目前支持
- vant 4
- element-ui 2
- element-plus 2
- antd 1、4、5
- antdv 3、4
- antd-mobile 5
- varlet 2、3
- naive 2
- primevue 3、4
- quasar 2
- @nextui-org/react 2
- @nuxt/ui 2
- @nuxt/ui-pro 1
- vuetify 3
- radix-vue 1
- next-ui 2
- arco-design/react 2
- arco-design/vue 2
- uview-ui 1、2
- uview-plus 3
- taro 3
- shacn-svelte 0
- bits-ui 0
- material-ui 5
- shadcn-ui 0
- tiny-vue 3
- nutui 4
- uview-plus 1
- tdesign-vue-next 1
- tdesign-mobile-vue 1
- tdesign-react 1
- tdesign-miniprogram 1
- @headlessui/vue 1
- @headlessui/react 2
- @chakraUi/react 2
- wot-design-uni 1
- ark/vue 4
- @dcloudio/uni-app 3
- @dcloudio/uni-ui 1

### [antdv demo](assets/antdv.gif)

### [varlet demo](assets/varlet.gif)

### [vant demo](assets/vant.gif)

### [antd demo](assets/antd.gif)

### [element-ui demo](assets/element.gif)

### [naive-ui demo](assets/naive.gif)

### [nuxt-ui demo](assets/nuxt-ui.gif)

### [vuetify demo](assets/vuetify.gif)

### [radix-vue demo](assets/radix-vue.gif)

### [next-ui demo](assets/next-ui.gif)

### [arco-design/react demo](assets/arco-design.gif)

### [arco-design/vue demo](assets/acro-design-vue.gif)

### [shadcn-svelte demo](assets/shadcn-svelte.gif)

### [bits-ui demo](assets/shadcn-svelte.gif)

## 选择指定的 UI 库（解决多个UI库命名冲突）

- `cmd+shift+p` -> 选择 `Specify the UI library you need to prompt`

## 只需要某一个 UI 库的类型怎么办？

- 方式一：使用命令面板选择 UI 库（会写入 `common-intellisense.ui`）
- 方式二：在 `settings.json` 手动配置（注意不要包含 `auto`）
  - 单个：`"common-intellisense.ui": ["antd5"]`
  - 多个：`"common-intellisense.ui": ["antd5", "elementPlus2"]`
- 如果是二次封装库，使用别名指向对应 UI 版本：
  - `"common-intellisense.alias": { "@xxx/element": "elementUi2" }`
- monorepo 场景支持按 `package.json` 路径区分配置：
  - `"common-intellisense.ui": { "${workspaceFolder}/packages/a/package.json": ["antd5"] }`

## configuration 设置

```
"common-intellisense.ui": {
          "type": "array",
          "default": ["auto"],
          "description": "指定提示的 UI 版本（不包含 auto 时仅使用手动指定的列表）"
},
"common-intellisense.showSlots": {
          "type": "boolean",
          "default": true,
          "description": "控制是否要展示 slots 节点"
},
"common-intellisense.alias": {
          "type": "object",
          "default": {},
          "description": "如果你需要将基于支持的 ui 库，二次封装的库，集成原本 ui 某一个版本的提示，可以使用别名 { \"@xxx/element\": \"elementUi2\" }"
},
"common-intellisense.remoteUris": {
    "type": "array",
    "default": [],
    "description": "远程URI (Remote URIs)"
  },
  "common-intellisense.remoteNpmUris": {
    "type": "array",
    "default": [],
    "description": "远程NPM URI (Remote NPM URIs)"
  },
  "common-intellisense.localUris": {
    "type": "array",
    "default": [],
    "description": "本地URI (Local URIs)"
  }
```

## 如何参与贡献

此仓库是个人维护, 需要经常同步一些 ui 库的更新,如果你有兴趣参与贡献,可以提交 PR 到对应 @common-intellisense 下的对应 UI 库所对应的版本 或者提供一些新的 ui 库,或者提供一些新的功能,欢迎提交 [issue](https://github.com/common-intellisense/common-intellisense/issues/3)

## 如何支持私有库

私有库建议通过 `remoteUris`、`remoteNpmUris` 或 `localUris` 提供纯数据 manifest。为保证 SSRF 防护，`remoteUris` 使用直连且固定 DNS 解析结果的传输方式，目前不会继承 VS Code、`HTTP_PROXY` 或 `HTTPS_PROXY` 代理配置；仅能通过企业代理联网时，请优先使用 `remoteNpmUris` 或工作区内的 `localUris` 数据 manifest：

```json
{
  "schemaVersion": 1,
  "exports": {
    "myUiComponents": { "map": [], "lib": "my-ui" },
    "myUi": { "uiName": "myUi", "lib": "my-ui", "map": [] }
  }
}
```

自定义来源的旧 CommonJS 适配器属于可执行代码，默认禁用，并且在 Restricted Mode 中始终禁用。仅当你完全信任来源时才设置 `"common-intellisense.allowLegacyAdapters": true`。`node:vm` 仅用于限制执行时间，不是安全沙箱。`localUris` 只允许工作区内部文件。

## 如何配置组件的json
```json
{
  "name": "组件名称如 Button.Group 或 VButton(大驼峰命名格式)",
  "props": {
    "attributeName": {
      "default": "默认值",
      "value": "如果有将生成属性 with=\"value\"",
      "type": "如果你使用 -> boolean / top / end /bottom / start 在创建属性时会有选项",
      "description": "en 描述",
      "description_zh": "zh 说明",
      "required": true, // 如果为true时select组件会自动有这个属性
      "foreach": false, // 它只适用于 vue，当你想使用 v-for 生成时
      "version": "提示在指定版本才可使用"
    }
  },
  "link": "en 指向文档的链接",
  "link_zh": "zh 链接到文档",
  "typeDetail": { // 用于补充属性依赖中的其他类型描述
    "AnchorItem": [ // 如果名称像 "$AnchorItem" 一样以 '$' 开头，则将被键入锚点项 = 'x' | 'y'
      {
        "name": "key",
        "description": "唯一ID",
        "type": "string | number"
      }
    ]
  },
  "events": [
    {
      "name": "close",
      "description": "单击关闭图标时发出。",
      "description_zh": "单击关闭图标时发出。",
      "params": "[MouseEvent]",
      "version": "提示在指定版本才可使用"
    }
  ],
  "exposed": [ // 使用 ref get vm, vm.value 或 vm.current 时会得到此提示
    {
      "name": "[string]",
      "description": "MISSING Description (edit in github)",
      "description_zh": "MISSING Description (edit in github)",
      "detail": "any"
    }
  ],
  "suggestions": [ // 一些组件是组合在一起的，当使用 button-group 时，内部提示会将此 `button` 提醒带上，如果此组件只有一个建议，则会选择button-group 自动创建按钮
    "v-alert-title"
  ]
}
```

## 如何配置自定义 [指令](https://github.com/common-intellisense/vuetify/blob/main/src/directives.json)

## 常见问题

- 如果你发现代码提示重复了，可能是因为插件升级了，但是老版本的插件仍然在生效, 尝试进入到 vscode 插件目录 `code ~/.vscode/extensions`, 然后删除低版本的 `simonhe.common-intellisense-low-version`，重启 vscode 即可
- 如果发现遇到 [All promises were rejected], 可以尝试卸载重新安装插件，或者检查本地网络代理，因为插件会多渠道请求不同源的 NPM 包，如果你的网络代理不通，可能会导致这个问题
- 如果你在内网环境或者没有网络的情况下使用，可以安装 [common-intellisense-local](https://marketplace.visualstudio.com/items?itemName=simonhe.common-intellisense-local)
- 如果你使用 `fnm` 或 `nvm` 等 `node` 版本工具 若出现下载异常、无法下载等问题、请检查系统环境变量是否设置
  - 使用 `fnm` 请添加 `%USERPROFILE%\AppData\Roaming\fnm\aliases\default` 环境变量

## :coffee:

[赞助 Common Intellisense](https://github.com/Simon-He95/sponsor)

## License

[MIT](./license)

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor@main/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor@main/sponsors.png"/>
  </a>
</p>
