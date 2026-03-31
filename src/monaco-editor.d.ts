// Type declaration for runtime-available monaco-editor module.
// Monaco is loaded by the VS Code workbench, not via npm.
declare module 'monaco-editor' {
  export const editor: any
  export const Uri: any
  export const languages: any
}
