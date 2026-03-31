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

  // Activate all extensions with '*' activation event
  const eagerExtensions = extensions.filter((ext) =>
    ext.activationEvents.includes('*') || ext.activationEvents.includes('onStartupFinished')
  );

  for (const ext of eagerExtensions) {
    await activateExtension(ext, vsCodeApi, bridge);
  }

  // Handle incoming RPC from OPIDE
  bridge.onMessage(async (msg: any) => {
    // Handle command execution requests from OPIDE
    if (msg.method === 'commands/execute' && msg.id) {
      const { command, args } = msg.params || {};
      try {
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
