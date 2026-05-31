// Native application-menu wiring.
//
// The Rust side (src-tauri/src/lib.rs) builds the macOS menu bar (and the
// Windows/Linux window menu) and emits a `menu-action` event carrying the
// clicked item's id. Predefined items (copy/paste/undo/quit/…) are handled
// natively by the OS and never reach here. The custom items carry a dotted id
// (e.g. `file.save`); this module maps each one to a VS Code workbench command
// or an OPIDE-specific action and runs it.

import { invoke } from '@tauri-apps/api/core'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

// Custom menu id → VS Code command id.
const COMMAND_MAP: Record<string, string> = {
  'file.new': 'workbench.action.files.newUntitledFile',
  'file.save': 'workbench.action.files.save',
  'file.saveAs': 'workbench.action.files.saveAs',
  'file.saveAll': 'workbench.action.files.saveAll',
  'file.closeEditor': 'workbench.action.closeActiveEditor',
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'edit.find': 'actions.find',
  'edit.replace': 'editor.action.startFindReplaceAction',
  'view.commandPalette': 'workbench.action.showCommands',
  'view.explorer': 'workbench.view.explorer',
  'view.search': 'workbench.view.search',
  'view.scm': 'workbench.view.scm',
  'view.terminal': 'workbench.action.terminal.toggleTerminal',
  'app.settings': 'workbench.action.openSettings',
}

/** Execute a VS Code workbench command through the running monaco-vscode-api. */
async function runVsCommand(commandId: string, ...args: unknown[]): Promise<void> {
  try {
    const { StandaloneServices } = await import('@codingame/monaco-vscode-api/services')
    const { ICommandService } = await import(
      '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands'
    )
    if (!ICommandService) return
    const commandService = StandaloneServices.get(ICommandService) as any
    if (!commandService?.executeCommand) return
    await commandService.executeCommand(commandId, ...args)
  } catch (e) {
    console.warn('[app-menu] command failed:', commandId, e)
  }
}

/** Open a native file picker and open the chosen file in the editor. */
async function openFilePicker(): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: false, multiple: false })
    if (typeof selected === 'string' && selected) {
      // `vscode.open` is a built-in command that opens a resource in an editor.
      await runVsCommand('vscode.open', URI.file(selected))
    }
  } catch (e) {
    console.warn('[app-menu] open file failed:', e)
  }
}

/**
 * Wire the native menu to the workbench. Call once after the workbench boots.
 */
export async function listenForMenuActions(): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event')
  await listen<string>('menu-action', async (event) => {
    const id = event.payload
    if (!id) return
    console.log('[app-menu] menu action:', id)

    // Direct command mappings (most File/Edit/View items).
    const cmd = COMMAND_MAP[id]
    if (cmd) {
      await runVsCommand(cmd)
      return
    }

    // OPIDE-specific actions.
    switch (id) {
      case 'file.open':
        await openFilePicker()
        break
      case 'file.openFolder': {
        // Use OPIDE's own folder-open flow (handles the workspace reload).
        const { pickAndOpenFolder } = await import('./workspace.ts')
        await pickAndOpenFolder()
        break
      }
      case 'window.close': {
        // Close the whole OPIDE window (Cmd+W stays bound to VS Code's
        // close-tab; this is the click-only "Close Window" item).
        try {
          const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
          await getCurrentWebviewWindow().close()
        } catch (e) {
          console.warn('[app-menu] close window failed:', e)
        }
        break
      }
      case 'help.docs':
        invoke('open_external', { url: 'https://github.com/OpenPawz/OPIDE' }).catch((e) => {
          console.warn('[app-menu] open docs failed:', e)
        })
        break
      default:
        console.warn('[app-menu] unhandled menu action:', id)
    }
  })
}
