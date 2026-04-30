// OPIDE Extension Host Bootstrap
//
// Entry point for the Node.js sidecar process.
// Spawned by Tauri's extension_host.rs with args:
//   --extensions-path ~/.opide/extensions
//   --workspace-path /Users/.../project
//
// Protocol: Content-Length framed JSON-RPC over stdin/stdout
// (same wire format as LSP, matching the Rust reader in extension_host.rs)

import { IpcBridge } from './ipc-bridge';
import { scanExtensions, ScannedExtension } from './extension-scanner';
import { createVSCodeApi } from './api-shim';
import * as path from 'path';

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs(): { extensionsPath: string; workspacePath: string } {
  const args = process.argv.slice(2);
  let extensionsPath = '';
  let workspacePath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--extensions-path' && args[i + 1]) {
      extensionsPath = args[++i];
    } else if (args[i] === '--workspace-path' && args[i + 1]) {
      workspacePath = args[++i];
    }
  }

  if (!extensionsPath) {
    extensionsPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      '.opide',
      'extensions'
    );
  }

  return { extensionsPath, workspacePath };
}

// ─── Extension activation ────────────────────────────────────────────────────

interface ActivatedExtension {
  id: string;
  exports: any;
  extension: ScannedExtension;
}

const activatedExtensions = new Map<string, ActivatedExtension>();

async function activateExtension(
  ext: ScannedExtension,
  vsCodeApi: ReturnType<typeof createVSCodeApi>,
  bridge: IpcBridge
): Promise<ActivatedExtension | null> {
  if (!ext.main) {
    bridge.log(`Skipping ${ext.id} — no main entry point (web-only extension)`);
    return null;
  }

  if (activatedExtensions.has(ext.id)) {
    return activatedExtensions.get(ext.id)!;
  }

  bridge.log(`Activating extension: ${ext.id} from ${ext.main}`);

  try {
    // Load and activate the extension
    const extModule = require(ext.main);

    let exports: any = {};
    if (typeof extModule.activate === 'function') {
      const context = vsCodeApi._createContext(ext.id, ext.path);
      exports = (await extModule.activate(context)) || {};
    }

    const activated: ActivatedExtension = { id: ext.id, exports, extension: ext };
    activatedExtensions.set(ext.id, activated);

    bridge.log(`Extension activated: ${ext.id}`);

    // Report contributed commands
    const commands = ext.contributes.commands || [];
    if (commands.length > 0) {
      bridge.log(`  Commands: ${commands.map((c) => c.command).join(', ')}`);
    }

    return activated;
  } catch (err: any) {
    bridge.log(`Failed to activate ${ext.id}: ${err.message || err}`);
    if (err.stack) {
      bridge.log(`  Stack: ${err.stack.split('\n').slice(0, 5).join('\n  ')}`);
    }
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { extensionsPath, workspacePath } = parseArgs();
  const bridge = new IpcBridge();

  bridge.log(`OPIDE Extension Host starting`);
  bridge.log(`  Extensions: ${extensionsPath}`);
  bridge.log(`  Workspace:  ${workspacePath}`);
  bridge.log(`  Node.js:    ${process.version}`);
  bridge.log(`  PID:        ${process.pid}`);

  // Create the VS Code API shim
  const vsCodeApi = createVSCodeApi(bridge, extensionsPath, workspacePath);

  // Inject the shim into require cache so require('vscode') returns our API.
  // We hook Module._load which is the lowest-level require interceptor that
  // still works in Node.js 22+ (unlike _resolveFilename which is now read-only).
  const OriginalModule = require('module');
  const originalLoad = OriginalModule._load;
  OriginalModule._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') {
      return vsCodeApi;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Scan for installed extensions
  const extensions = scanExtensions(extensionsPath);
  bridge.log(`Found ${extensions.length} extension(s)`);

  for (const ext of extensions) {
    bridge.log(`  ${ext.id} — main: ${ext.main ? 'yes' : 'no (web-only)'}`);
  }

  // ── CC1: Activation events ───────────────────────────────────────────
  //
  // VS Code activates extensions lazily based on `activationEvents` in
  // their package.json. The classic events:
  //   - "*"                       → on startup (deprecated but common)
  //   - "onStartupFinished"       → after workbench finishes loading
  //   - "onLanguage:python"       → when a file of that language opens
  //   - "onCommand:foo.bar"       → when foo.bar is invoked
  //   - "onView:treeId"           → when a view becomes visible
  //   - "workspaceContains:**/*.x"→ when a file matching pattern exists
  //   - "onDebug" / "onDebugResolve:python" → debug-related triggers
  //   - "onChat:participantId"    → OPIDE-specific: when a chat
  //     participant is mentioned (Phase B.B1).
  //
  // Phase v1 covers `*`, `onStartupFinished`, `workspaceContains:`, and
  // `onLanguage:` (with the language list driven by file extensions on
  // workspace contents). Lazy `onCommand:` activation runs through the
  // 'commands/execute' handler below — if the command is owned by an
  // unactivated extension we activate first.
  // -------------------------------------------------------------------

  function matchesEager(ae: string): boolean {
    if (ae === '*' || ae === 'onStartupFinished' || ae === 'onUri') return true;
    if (ae.startsWith('workspaceContains:')) return matchesWorkspaceContains(ae.split(':', 2)[1] || '');
    if (ae === 'onDebug') return false; // wait for actual debug session
    return false;
  }

  function matchesWorkspaceContains(pattern: string): boolean {
    if (!workspacePath || !pattern) return false;
    // Cheap glob check: split pattern on '/' and walk; for the '**/*.ext'
    // common case we just look for a file with that extension anywhere.
    try {
      const fs = require('fs');
      const pathLib = require('path');
      const extMatch = pattern.match(/\*\.([a-zA-Z0-9]+)/);
      const targetExt = extMatch ? `.${extMatch[1]}` : null;
      function walk(dir: string, depth: number): boolean {
        if (depth > 4) return false;
        let entries: any[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
        for (const ent of entries) {
          if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const full = pathLib.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (walk(full, depth + 1)) return true;
          } else if (targetExt && ent.name.endsWith(targetExt)) {
            return true;
          } else if (ent.name === pattern) {
            return true;
          }
        }
        return false;
      }
      return walk(workspacePath, 0);
    } catch {
      return false;
    }
  }

  const eagerExtensions = extensions.filter((ext) =>
    ext.activationEvents.some(matchesEager),
  );

  for (const ext of eagerExtensions) {
    await activateExtension(ext, vsCodeApi, bridge);
  }

  /** Activate every extension whose activationEvents match an event
   * the user just triggered (onLanguage, onCommand, onView, etc).
   * Idempotent — already-activated extensions are no-ops. */
  async function activateMatching(eventName: string): Promise<void> {
    for (const ext of extensions) {
      if (activatedExtensions.has(ext.id)) continue;
      const matched = ext.activationEvents.some((ae) => ae === eventName);
      if (matched) {
        await activateExtension(ext, vsCodeApi, bridge);
      }
    }
  }

  // Handle incoming RPC from OPIDE
  bridge.onMessage(async (msg: any) => {
    // Handle command execution requests from OPIDE
    if (msg.method === 'commands/execute' && msg.id) {
      const { command, args } = msg.params || {};
      try {
        // CC1: lazy onCommand activation. If no extension has registered
        // the command yet but a scanned extension declares
        // onCommand:<command> in activationEvents, activate it before
        // dispatching.
        await activateMatching(`onCommand:${command}`);
        const result = await vsCodeApi.commands.executeCommand(command, ...(args || []));
        bridge.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      } catch (err: any) {
        bridge.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -1, message: err.message || 'Command failed' },
        });
      }
      return;
    }

    // CC1: language activation — fired by the workbench when a file
    // opens. We call activateMatching with onLanguage:<id> so any
    // language-targeted extensions activate before the file's first
    // syntax/lint pass.
    if (msg.method === 'activation/onLanguage' && msg.params?.languageId) {
      await activateMatching(`onLanguage:${msg.params.languageId}`);
      if (msg.id) bridge.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === 'activation/onView' && msg.params?.viewId) {
      await activateMatching(`onView:${msg.params.viewId}`);
      if (msg.id) bridge.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === 'activation/onChat' && msg.params?.participantId) {
      await activateMatching(`onChat:${msg.params.participantId}`);
      if (msg.id) bridge.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === 'activation/onDebug') {
      await activateMatching('onDebug');
      if (msg.params?.type) await activateMatching(`onDebugResolve:${msg.params.type}`);
      if (msg.id) bridge.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }

    // Handle extension activation requests
    if (msg.method === 'extension/activate' && msg.params?.extensionId) {
      const ext = extensions.find((e) => e.id === msg.params.extensionId);
      if (ext) {
        await activateExtension(ext, vsCodeApi, bridge);
      }
      if (msg.id) {
        bridge.send({ jsonrpc: '2.0', id: msg.id, result: { activated: !!ext } });
      }
      return;
    }

    // Handle shutdown
    if (msg.method === 'shutdown') {
      bridge.log('Received shutdown — deactivating extensions');
      for (const [id, activated] of activatedExtensions) {
        try {
          const extModule = require(activated.extension.main!);
          if (typeof extModule.deactivate === 'function') {
            await extModule.deactivate();
            bridge.log(`Deactivated: ${id}`);
          }
        } catch (err: any) {
          bridge.log(`Error deactivating ${id}: ${err.message}`);
        }
      }
      process.exit(0);
    }
  });

  // Send ready notification to OPIDE
  bridge.send({
    jsonrpc: '2.0',
    method: 'extensionHost/ready',
    params: {
      extensions: extensions.map((ext) => ({
        id: ext.id,
        name: ext.manifest.displayName || ext.manifest.name,
        version: ext.manifest.version,
        hasMain: !!ext.main,
        activationEvents: ext.activationEvents,
        commands: (ext.contributes.commands || []).map((c) => c.command),
      })),
      activated: [...activatedExtensions.keys()],
    },
  });

  bridge.log('Extension host ready — waiting for messages');

  // Keep process alive
  setInterval(() => {
    // Heartbeat — prevents Node.js from exiting when there's nothing on the event loop
  }, 60_000);
}

// ─── Error handling ──────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  process.stderr.write(`[ext-host] Uncaught exception: ${err.message}\n${err.stack}\n`);
  // Don't exit — try to keep running for other extensions
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[ext-host] Unhandled rejection: ${reason}\n`);
});

// ─── Go ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  process.stderr.write(`[ext-host] Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
