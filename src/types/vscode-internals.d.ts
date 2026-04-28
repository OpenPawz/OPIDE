// Type declarations for internal VS Code modules accessed via
// @codingame/monaco-vscode-api.  These paths are not part of the
// public API surface so they have no shipped typings.  Declaring them
// here lets us drop the @ts-ignore annotations throughout the codebase
// while still treating the values as `any` at the type level.

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions' {
  export const Action2: any
  export const registerAction2: any
  export const MenuRegistry: any
  export const MenuId: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands' {
  export const ICommandService: any
  export const CommandsRegistry: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration' {
  export const IConfigurationService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement' {
  export const IExtensionManagementService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement.service' {
  export const IExtensionManagementService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification' {
  export const INotificationService: any
  export const Severity: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput' {
  export const IQuickInputService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput.service' {
  export const IQuickInputService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/base/common/uri' {
  export const URI: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService' {
  export const IEditorService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/workbench/services/output/common/output' {
  export const IOutputService: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/workbench/services/statusbar/browser/statusbar' {
  export const IStatusbarService: any
  export const StatusbarAlignment: any
}

declare module '@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService.service' {
  export const IWorkbenchThemeService: any
}
