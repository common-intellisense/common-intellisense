<p align="center">
<img height="200" src="./assets/kv.png" alt="common-intellisense">
</p>
<p align="center"> English | <a href="https://github.com/Simon-He95/vscode-common-intellisense/blob/main/README_zh.md">简体中文</a></p>

This plugin can provide a super powerful smart prompt function, including properties, events, slots and corresponding annotations and types, methods on instances, etc. It supports multiple UI libraries, taking your development efficiency to the next level.

### 🛠️️ How to use
Install the supported ui component library in your project and install the plug-in. If the plug-in does not work, you can restart vscode. If you encounter problems, you can open an issue.

### 🍬 Currently supported
- vant 4
- element 2
- element-plus 2
- antd 1、4、5
- antdv 1、3、4
- antd-mobile 5
- varlet 2、3
- naive 2
- primevue 3
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

## Select the specified UI library (resolve multiple UI library naming conflicts)

- `cmd+shift+p` -> Select `Specify the UI library you need to prompt`

## configuration

```
"common-intellisense.showSlots": {
          "type": "boolean",
          "default": true,
          "description": "Whether to show the slots on template completion."
},
"common-intellisense.alias": {
          "type": "object",
          "default": {},
          "description": "If you need to integrate the supported ui library, the secondary encapsulated library, and the prompt to integrate a certain version of the original ui, you can use the alias { \"@xxx/element\": \"elementUi2\" }"
},
"common-intellisense.remoteUris": {
  "type": "array",
  "default": [],
  "description": "Remote URIs"
}
```

## How to Contribute

This repository is maintained by individuals, and needs to be updated with some UI libraries frequently. If you are interested in contributing, you can submit a PR to the corresponding version of the corresponding UI library under @common-intellisense or provide some new UI libraries or some new features. Submissions are welcome. [issue](https://github.com/common-intellisense/common-intellisense/issues/3)

## How to support private libraries

If your project is a private library, you can also refer to [vuetify](https://github.com/common-intellisense/vuetify3), provide an exported uri, if your uri is an accessible packaged `dist/index.cjs` address, in vscode `common-intellisense.remoteUris`, configure this link, the plug-in will request this link and get the corresponding prompt information. You can also directly configure an npm package name (@xx/yy-ui), configure it in `common-intellisense.remoteNpmUris`, so that the plug-in will request the `dist/index.cjs` produced by the npm package and get the corresponding prompt information.

## :coffee:

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)

## License

[MIT](./license)

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor@main/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor@main/sponsors.png"/>
  </a>
</p>
