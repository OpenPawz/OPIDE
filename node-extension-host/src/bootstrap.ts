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

// ─── fs.watch FD cap ─────────────────────────────────────────────────────────
//
// Roo (and other extensions using chokidar internally) can launch
// hundreds of recursive file watchers, each consuming a file
// descriptor. Even with `ulimit -n 65536`, a chokidar `watch('/')`
// pointed at a sufficiently large tree blows the limit and trips
// EMFILE on every subsequent fs.open — wedging the sidecar.
//
// Patch fs.watch + fs.watchFile globally to:
//   1. Cap the total active watcher count at MAX_WATCHERS.
//   2. Once over the cap, return a no-op watcher (extension's change
//      events stop firing, but it doesn't crash; the IDE stays alive).
//   3. Log every cap hit so we can see which extensions are abusive.
//
// Done before any extension code can require('fs').
{
  const MAX_WATCHERS = 4096;
  const fs = require('fs');
  const realWatch = fs.watch;
  const realWatchFile = fs.watchFile;
  let active = 0;
  let warned = false;
  function noopWatcher(): any {
    return {
      close: () => {},
      on: () => {},
      addListener: () => {},
      removeListener: () => {},
      removeAllListeners: () => {},
      emit: () => false,
      ref: () => {},
      unref: () => {},
    };
  }
  fs.watch = function patchedWatch(this: any, ...args: any[]): any {
    if (active >= MAX_WATCHERS) {
      if (!warned) {
        warned = true;
        process.stderr.write(
          `[bootstrap] fs.watch cap hit (${MAX_WATCHERS}). Returning no-op watchers; ` +
          `extension that hit the cap will stop receiving file change events. ` +
          `First over-cap path: ${String(args[0]).slice(0, 200)}\n`,
        );
      }
      return noopWatcher();
    }
    let watcher: any;
    try {
      watcher = realWatch.apply(fs, args as any);
    } catch (e: any) {
      // EMFILE etc — return no-op so the extension doesn't crash.
      process.stderr.write(`[bootstrap] fs.watch threw (${e?.code || e?.message}); returning no-op\n`);
      return noopWatcher();
    }
    active++;
    const realClose = watcher.close.bind(watcher);
    let closed = false;
    watcher.close = (...closeArgs: any[]) => {
      if (!closed) { closed = true; active--; }
      return realClose(...closeArgs);
    };
    return watcher;
  };
  // watchFile uses StatWatchers — same FD pressure. Apply the same cap.
  fs.watchFile = function patchedWatchFile(this: any, ...args: any[]): any {
    if (active >= MAX_WATCHERS) return noopWatcher();
    return realWatchFile.apply(fs, args as any);
  };
}

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
      // Track which extension is currently activating so api-shim
      // calls (registerWebviewViewProvider, createWebviewPanel, etc.)
      // can attribute the call back to the originating extension —
      // needed to grant resource roots and origin keying on webviews.
      if (typeof (vsCodeApi as any)._setCurrentExtension === 'function') {
        (vsCodeApi as any)._setCurrentExtension(ext.id, ext.path);
      }
      try {
        exports = (await extModule.activate(context)) || {};
      } finally {
        if (typeof (vsCodeApi as any)._setCurrentExtension === 'function') {
          (vsCodeApi as any)._setCurrentExtension(null, null);
        }
      }
    }

    const activated: ActivatedExtension = { id: ext.id, exports, extension: ext };
    activatedExtensions.set(ext.id, activated);
    if (typeof (vsCodeApi as any)._markExtensionActivated === 'function') {
      (vsCodeApi as any)._markExtensionActivated(ext.id, exports);
    }

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

  // Populate vscode.extensions.getExtension data BEFORE any activate()
  // runs. Extensions read their own packageJSON via getExtension during
  // activation (Claude Code reads its version, Continue reads its
  // displayName, etc); without this they'd see undefined and crash.
  if (typeof (vsCodeApi as any)._setExtensionRegistry === 'function') {
    (vsCodeApi as any)._setExtensionRegistry(extensions.map((e) => ({
      id: e.id,
      path: e.path,
      manifest: e.manifest,
    })));
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

  // Eager triggers only — anything cheap to evaluate at startup.
  // workspaceContains: was here originally, but a synchronous fs walk
  // PER PATTERN PER EXTENSION on every workspace open was hanging the
  // host. It now runs in a deferred pass after the sidecar sends
  // extensionHost/ready, with depth limits, dir skips, and a time
  // budget so the IDE never waits on it.
  function matchesEager(ae: string): boolean {
    if (ae === '*' || ae === 'onStartupFinished' || ae === 'onUri') return true;
    return false;
  }

  const eagerExtensions = extensions.filter((ext) =>
    ext.activationEvents.some(matchesEager),
  );

  for (const ext of eagerExtensions) {
    await activateExtension(ext, vsCodeApi, bridge);
  }

  /** Bounded, post-ready workspaceContains evaluator. Runs on a
   * setImmediate so it never blocks startup. Walks at most
   * MAX_DEPTH levels deep, skips heavy dirs, and stops after
   * MAX_BUDGET_MS even if patterns remain unchecked.
   *
   * If a match is found, the extension activates lazily — same code
   * path the activateMatching helper uses for onLanguage / onView. */
  function evaluateWorkspaceContainsLater(): void {
    const candidates = extensions.filter((ext) =>
      !activatedExtensions.has(ext.id) &&
      ext.activationEvents.some((ae) => ae.startsWith('workspaceContains:')),
    );
    if (candidates.length === 0 || !workspacePath) return;

    setImmediate(() => {
      const fs = require('fs');
      const pathLib = require('path');
      const MAX_DEPTH = 3;
      const MAX_BUDGET_MS = 1500;
      const SKIP = new Set([
        'node_modules', 'target', 'dist', 'build', '.git', '.svn',
        '.hg', 'venv', '.venv', '__pycache__', '.next', '.cache',
        '.tauri', '.opide', 'vendor', 'Pods', 'DerivedData',
      ]);
      const startedAt = Date.now();

      // Build the set of unique patterns we still care about, deduped
      // so we walk the tree once even if N extensions share a pattern.
      const patterns = new Map<string, Set<string>>(); // pattern → set of extension ids
      for (const ext of candidates) {
        for (const ae of ext.activationEvents) {
          if (!ae.startsWith('workspaceContains:')) continue;
          const p = ae.slice('workspaceContains:'.length);
          if (!p) continue;
          if (!patterns.has(p)) patterns.set(p, new Set());
          patterns.get(p)!.add(ext.id);
        }
      }
      if (patterns.size === 0) return;

      const matches = new Set<string>(); // extension ids that hit
      function patternHits(name: string): string[] {
        const hits: string[] = [];
        for (const [pat] of patterns) {
          // Common forms: "**/*.ext", "**/foo.json", or a literal name.
          const extMatch = pat.match(/\*\.([a-zA-Z0-9]+)$/);
          if (extMatch && name.endsWith(`.${extMatch[1]}`)) hits.push(pat);
          else if (name === pat) hits.push(pat);
          else if (pat.endsWith(`/${name}`) || pat === name) hits.push(pat);
        }
        return hits;
      }

      function walk(dir: string, depth: number): void {
        if (depth > MAX_DEPTH) return;
        if (Date.now() - startedAt > MAX_BUDGET_MS) return;
        let entries: any[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (Date.now() - startedAt > MAX_BUDGET_MS) return;
          if (ent.name.startsWith('.') || SKIP.has(ent.name)) continue;
          if (ent.isDirectory()) {
            walk(pathLib.join(dir, ent.name), depth + 1);
          } else {
            const hits = patternHits(ent.name);
            for (const h of hits) {
              const owners = patterns.get(h);
              if (owners) for (const id of owners) matches.add(id);
              patterns.delete(h); // stop checking this pattern
            }
            if (patterns.size === 0) return;
          }
        }
      }

      try { walk(workspacePath, 0); } catch { /* swallow */ }

      // Activate each matched extension lazily.
      for (const ext of candidates) {
        if (matches.has(ext.id) && !activatedExtensions.has(ext.id)) {
          activateExtension(ext, vsCodeApi, bridge).catch((e) =>
            bridge.log(`workspaceContains activation failed for ${ext.id}: ${e?.message || e}`),
          );
        }
      }
      bridge.log(
        `workspaceContains scan: ${matches.size}/${candidates.length} matched, ` +
        `${Date.now() - startedAt}ms elapsed${Date.now() - startedAt > MAX_BUDGET_MS ? ' (BUDGETED)' : ''}`,
      );
    });
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
  // Includes the contributed view containers + view slots so the
  // workbench can pre-mount them BEFORE the extension activates
  // (VS Code's two-phase contribution model). The bridge wires
  // activity-bar icons and reserves view slots; the extension's
  // registerWebviewViewProvider / registerTreeDataProvider then
  // attach to the existing slot when the user reveals the view.
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
        contributedViewContainers: ext.contributedViewContainers,
        contributedViews: ext.contributedViews,
      })),
      activated: [...activatedExtensions.keys()],
    },
  });

  bridge.log('Extension host ready — waiting for messages');

  // CC1: kick off the deferred workspaceContains scan AFTER the bridge
  // has been told we're ready. The scan walks the workspace under a
  // 1.5s budget and depth-3 cap; matched extensions activate lazily.
  // No part of this blocks the user opening a folder.
  evaluateWorkspaceContainsLater();

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
