# OPIDE Path B — Use monaco-vscode-api's real webview infrastructure

## Discovery

We already have `@codingame/monaco-vscode-view-common-service-override` installed
(v28.0.1, in node_modules, listed in package.json). It provides:

- `IWebviewService` — `createWebviewElement(initInfo): IWebviewElement`
- `IWebviewViewService` — `register(viewType, resolver)`

Both are real VS Code services that handle:
- iframe creation, sandbox, CSP, nonce
- `acquireVsCodeApi()` shim injected automatically
- postMessage protocol with proper queueing
- `localResourceRoots` → service-worker-served webview-resource:// URLs
- Lifecycle (mount/unmount, focus, visibility)
- `setHtml`, `postMessage`, `onMessage` API matching VS Code's IWebview

We never registered the service in `src/workbench.ts`, which is why our
hand-rolled `extension-webview-views.ts` and `extension-webviews.ts` had to
reimplement (badly) what the workbench already provides.

## Plan

### Step 1 — Register view-common service override
File: `src/workbench.ts`

- Add import: `import getViewCommonServiceOverride from '@codingame/monaco-vscode-view-common-service-override'`
- Add to overrides block: `...getViewCommonServiceOverride()`
- Verify: type-check, then runtime check that `IWebviewService` resolves via DI

### Step 2 — Rewrite `src/opide/extension-webview-views.ts`
Replace the entire iframe-creation path with `IWebviewViewService.register`.

```ts
const webviewViewService = StandaloneServices.get(IWebviewViewService)
webviewViewService.register(viewId, {
  resolve(webviewView, cancellation) {
    // webviewView.webview is an IWebview from the workbench
    // bridge it to the sidecar's resolveWebviewView RPC
    webviewView.webview.onMessage(({ message }) =>
      bridge.notifyExtensionMessage(viewId, message))
    onResolveCallback(webviewView.webview)
    return Promise.resolve()
  }
})
```

Then `setWebviewViewHtml` becomes `webview.setHtml(html)` — no rewriting,
no injection, no marker, no CSP fiddling.

`postMessageToWebviewView` becomes `webview.postMessage(msg)`.

Keep the `findPreMountedSlot` / contributed-views pre-mount logic — that
still owns the auxiliary-bar tab. The webview goes INSIDE the slot.

### Step 3 — Rewrite `src/opide/extension-webviews.ts`
Same idea for `createWebviewPanel`. Use `IWebviewService.createWebviewElement`
to get an IWebviewElement, mount its `.container` into the editor area's
panel host.

### Step 4 — Update `node-extension-host/src/api-shim.ts`
The shim's `webview` object needs to call:
- `setHtml` → bridge → workbench webview.setHtml
- `postMessage` → bridge → workbench webview.postMessage
- onDidReceiveMessage → bridge fires when workbench webview emits onMessage
- `asWebviewUri(fsPath)` → return webview's resource URI (workbench gives a real
  `https://<webview-id>.vscode-cdn.net/...` style URL via service worker;
  we just call into the webview to compute it, OR just return file:// and let
  workbench's localResourceRoots resolve)

### Step 5 — Delete dead code
After Steps 2-4 work, remove:
- `injectScripts()` and all CSP / URL rewriting
- `opide-ext://` Tauri scheme handler in `src-tauri/src/lib.rs`
  (workbench has its own `vscode-webview://` resource scheme via its service worker)
- `_setExtensionRegistry`-only-needed-for-iframe pieces stay; they're useful
  for `vscode.extensions.getExtension`
- The diagnostic `iframe LOADED` / `asset OK` / `CSP blocked` plumbing —
  workbench webview has its own `onFatalError` / `onMissingCsp` events

### Step 6 — Update `_createContext` defaults
Keep the `environmentVariableCollection` and `extension` shims — those are
context-level, not webview-level, and they were correct fixes regardless of
which webview path we use.

### Step 7 — Validate
- Anthropic.claude-code — sidebar populates, can talk to claude CLI
- continue.continue — sidebar webview renders
- saoudrizwan.claude-dev (Cline)
- GitHub.vscode-pull-request-github
- Confirm asWebviewUri returns a URL the iframe can fetch
- Confirm postMessage round-trips

### Step 8 — Cleanup commit
One commit that:
- registers view-common service
- rewrites webview-views and webviews modules to use real services
- deletes the iframe / CSP / opide-ext layer
- references this plan file in the commit body
