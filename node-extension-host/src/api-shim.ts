// VS Code API Shim — provides the `vscode` namespace that extensions import.
//
// This is NOT a complete implementation of the VS Code API. It implements
// the most-used APIs that cover ~80% of popular extensions. Each API call
// is proxied to the OPIDE frontend via the IPC bridge.
//
// Strategy: start minimal, log unimplemented calls, expand as needed.
// When an extension calls an unimplemented API, we log it and return
// a safe default. This lets most extensions partially work immediately.

import { IpcBridge } from './ipc-bridge';
import { EventEmitter } from 'events';
import * as path from 'path';

// ─── Event infrastructure ────────────────────────────────────────────────────

class VSCodeEvent<T> {
  private emitter = new EventEmitter();
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  fire(data: T): void {
    this.emitter.emit('fire', data);
  }

  get event(): (listener: (e: T) => any) => { dispose(): void } {
    return (listener: (e: T) => any) => {
      this.emitter.on('fire', listener);
      return {
        dispose: () => {
          this.emitter.removeListener('fire', listener);
        },
      };
    };
  }
}

// ─── Core data types ─────────────────────────────────────────────────────────

class Position {
  constructor(public readonly line: number, public readonly character: number) {}
  translate(lineDelta = 0, charDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + charDelta);
  }
  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isAfter(other: Position): boolean {
    return !this.isEqual(other) && !this.isBefore(other);
  }
  compareTo(other: Position): number {
    if (this.isBefore(other)) return -1;
    if (this.isAfter(other)) return 1;
    return 0;
  }
}

class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number | Position, startChar: number | Position, endLine?: number, endChar?: number) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine!, endChar!);
    }
  }
  get isEmpty(): boolean { return this.start.isEqual(this.end); }
  get isSingleLine(): boolean { return this.start.line === this.end.line; }
  contains(posOrRange: Position | Range): boolean {
    if (posOrRange instanceof Position) {
      return !posOrRange.isBefore(this.start) && !posOrRange.isAfter(this.end);
    }
    return this.contains(posOrRange.start) && this.contains(posOrRange.end);
  }
  with(start?: Position, end?: Position): Range {
    return new Range(start ?? this.start, end ?? this.end);
  }
}

class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(scheme: string, authority: string, fsPath: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = fsPath;
    this.query = query;
    this.fragment = fragment;
  }

  get fsPath(): string { return this.path; }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  static file(fsPath: string): Uri {
    return new Uri('file', '', path.resolve(fsPath));
  }

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(':', ''), url.hostname, url.pathname, url.search, url.hash);
    } catch {
      return Uri.file(value);
    }
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, base.authority, path.join(base.path, ...segments));
  }
}

class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(anchorLine: number | Position, anchorChar: number | Position, activeLine?: number, activeChar?: number) {
    if (anchorLine instanceof Position && anchorChar instanceof Position) {
      super(anchorLine, anchorChar);
      this.anchor = anchorLine;
      this.active = anchorChar;
    } else {
      super(anchorLine as number, anchorChar as number, activeLine!, activeChar!);
      this.anchor = new Position(anchorLine as number, anchorChar as number);
      this.active = new Position(activeLine!, activeChar!);
    }
  }
  get isReversed(): boolean { return this.anchor.isAfter(this.active); }
}

// ─── TextDocument ────────────────────────────────────────────────────────────

class TextDocument {
  uri: Uri;
  languageId: string;
  version: number;
  private _content: string;
  private _lines: string[];
  private _eol: number; // 1=LF, 2=CRLF

  constructor(uri: Uri, languageId: string, version: number, content: string) {
    this.uri = uri;
    this.languageId = languageId;
    this.version = version;
    this._content = content;
    this._eol = content.includes('\r\n') ? 2 : 1;
    this._lines = content.split(/\r?\n/);
  }

  get fileName(): string { return this.uri.fsPath; }
  get isUntitled(): boolean { return false; }
  get isDirty(): boolean { return false; }
  get isClosed(): boolean { return false; }
  get eol(): number { return this._eol; }
  get lineCount(): number { return this._lines.length; }

  getText(range?: Range): string {
    if (!range) return this._content;
    const startOff = this.offsetAt(range.start);
    const endOff = this.offsetAt(range.end);
    return this._content.substring(startOff, endOff);
  }

  lineAt(lineOrPos: number | Position): any {
    const line = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
    const text = this._lines[line] || '';
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex: text.search(/\S/) === -1 ? text.length : text.search(/\S/),
      isEmptyOrWhitespace: text.trim().length === 0,
    };
  }

  offsetAt(position: Position): number {
    let offset = 0;
    for (let i = 0; i < position.line && i < this._lines.length; i++) {
      offset += this._lines[i].length + 1; // +1 for newline
    }
    return offset + Math.min(position.character, (this._lines[position.line] || '').length);
  }

  positionAt(offset: number): Position {
    let remaining = offset;
    for (let i = 0; i < this._lines.length; i++) {
      if (remaining <= this._lines[i].length) {
        return new Position(i, remaining);
      }
      remaining -= this._lines[i].length + 1;
    }
    return new Position(this._lines.length - 1, (this._lines[this._lines.length - 1] || '').length);
  }

  getWordRangeAtPosition(position: Position, _regex?: RegExp): Range | undefined {
    return undefined;
  }

  validateRange(range: Range): Range { return range; }
  validatePosition(position: Position): Position { return position; }

  _update(content: string, version: number): void {
    this._content = content;
    this.version = version;
    this._lines = content.split(/\r?\n/);
    this._eol = content.includes('\r\n') ? 2 : 1;
  }
}

// ─── TextEdit ────────────────────────────────────────────────────────────────

class TextEdit {
  range: Range;
  newText: string;
  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }
  static setEndOfLine(_eol: number): TextEdit {
    return new TextEdit(new Range(0, 0, 0, 0), '');
  }
}

// ─── Diagnostic types ────────────────────────────────────────────────────────

enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number;

  constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

// ─── Enums ───────────────────────────────────────────────────────────────────

enum StatusBarAlignment { Left = 1, Right = 2 }
enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }
enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }
enum CompletionItemKind {
  Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4,
  Variable = 5, Class = 6, Interface = 7, Module = 8, Property = 9,
  Unit = 10, Value = 11, Enum = 12, Keyword = 13, Snippet = 14,
  Color = 15, File = 16, Reference = 17, Folder = 18, EnumMember = 19,
  Constant = 20, Struct = 21, Event = 22, Operator = 23, TypeParameter = 24,
}

// Phase A: decoration enums. These are passed by value through the IPC and
// translated to Monaco constants in the bridge; we just need to expose the
// numeric values that match the public VS Code API contract.
enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
enum DecorationRangeBehavior {
  OpenOpen = 0, ClosedClosed = 1, OpenClosed = 2, ClosedOpen = 3,
}
enum TextEditorCursorStyle {
  Line = 1, Block = 2, Underline = 3, LineThin = 4, BlockOutline = 5, UnderlineThin = 6,
}

// ─── Build the API ───────────────────────────────────────────────────────────

let _nextRequestId = 1;

export function createVSCodeApi(bridge: IpcBridge, extensionPath: string, workspacePath: string) {
  const commandRegistry = new Map<string, (...args: any[]) => any>();
  const diagnosticCollections = new Map<string, Map<string, Diagnostic[]>>();
  const outputChannels = new Map<string, string[]>();
  const disposables: Array<{ dispose(): void }> = [];

  // Pending RPC responses
  const pendingRequests = new Map<number, { resolve: Function; reject: Function }>();

  // Send an RPC request to OPIDE and wait for response
  function rpcRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = _nextRequestId++;
      pendingRequests.set(id, { resolve, reject });
      bridge.send({ jsonrpc: '2.0', id, method, params });

      // Timeout after 30s
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  // Handle responses from OPIDE
  bridge.onMessage((msg: any) => {
    if (msg.id && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || 'RPC error'));
      } else {
        resolve(msg.result);
      }
    }
    // Also handle notifications (events from OPIDE → extensions)
    if (msg.method && !msg.id) {
      // These are events pushed from the frontend
      handleNotification(msg.method, msg.params);
    }
  });

  // Event dispatchers
  const onDidChangeTextDoc = new VSCodeEvent<any>('onDidChangeTextDocument');
  const onDidOpenTextDoc = new VSCodeEvent<any>('onDidOpenTextDocument');
  const onDidCloseTextDoc = new VSCodeEvent<any>('onDidCloseTextDocument');
  const onDidSaveTextDoc = new VSCodeEvent<any>('onDidSaveTextDocument');
  const onDidChangeConfig = new VSCodeEvent<any>('onDidChangeConfiguration');
  const onDidChangeActiveEditor = new VSCodeEvent<any>('onDidChangeActiveTextEditor');

  // Document registry — keeps content cached so getText() is synchronous
  const openDocuments = new Map<string, TextDocument>();

  // Current active editor state
  let _activeTextEditor: any = undefined;

  // ── Phase A registries ────────────────────────────────────────────────
  // Decoration type registry. Each createTextEditorDecorationType allocates
  // a unique key the bridge uses to identify the decoration type when we
  // call setDecorations later.
  const _decorationTypes = new Map<string, any>();
  let _nextDecorationTypeId = 1;

  // Webview panel registry. Each createWebviewPanel allocates a panelId
  // the bridge uses to address that panel. Reverse direction (webview →
  // extension) routes through 'webview/messageFromWebview' notifications
  // tagged with the same panelId.
  interface WebviewPanelInst {
    panelId: string;
    viewType: string;
    title: string;
    htmlValue: string;
    onDidReceiveMessageEvent: VSCodeEvent<any>;
    onDidDisposeEvent: VSCodeEvent<void>;
    onDidChangeViewStateEvent: VSCodeEvent<any>;
    disposed: boolean;
    visible: boolean;
    active: boolean;
    extPath: string;
  }
  const _webviewPanels = new Map<string, WebviewPanelInst>();
  let _nextPanelId = 1;

  function handleNotification(method: string, params: any) {
    switch (method) {
      case 'textDocument/didOpen': {
        const doc = new TextDocument(
          Uri.file(params.uri),
          params.languageId || 'plaintext',
          params.version || 1,
          params.text || '',
        );
        openDocuments.set(params.uri, doc);
        onDidOpenTextDoc.fire(doc);
        break;
      }

      case 'textDocument/didChange': {
        const doc = openDocuments.get(params.uri);
        if (doc && params.contentChanges?.[0]?.text != null) {
          doc._update(params.contentChanges[0].text, params.version || doc.version + 1);
        }
        onDidChangeTextDoc.fire({ document: doc, contentChanges: params.contentChanges || [] });
        break;
      }

      case 'textDocument/didClose': {
        openDocuments.delete(params.uri);
        onDidCloseTextDoc.fire(params);
        break;
      }

      case 'textDocument/didSave':
        onDidSaveTextDoc.fire(params);
        break;

      case 'configuration/didChange':
        onDidChangeConfig.fire(params);
        break;

      // Phase A: round-trip messages from the webview iframe back to the
      // extension. The bridge fires this with { panelId, message } so we
      // can dispatch to the panel's onDidReceiveMessage event emitter.
      case 'webview/messageFromWebview': {
        const panel = _webviewPanels.get(params?.panelId);
        if (panel && !panel.disposed) {
          panel.onDidReceiveMessageEvent.fire(params?.message);
        }
        break;
      }
      // Bridge tells us the user closed the panel UI (X button etc).
      case 'webview/didDispose': {
        const panel = _webviewPanels.get(params?.panelId);
        if (panel && !panel.disposed) {
          panel.disposed = true;
          panel.onDidDisposeEvent.fire(undefined as any);
        }
        break;
      }
      // View-state changes (visible / focused) for chrome management.
      case 'webview/didChangeViewState': {
        const panel = _webviewPanels.get(params?.panelId);
        if (panel && !panel.disposed) {
          panel.visible = !!params?.visible;
          panel.active = !!params?.active;
          panel.onDidChangeViewStateEvent.fire({
            webviewPanel: panel,
            visible: panel.visible,
            active: panel.active,
          });
        }
        break;
      }
      case 'editor/didChangeActive': {
        if (!params?.uri) {
          _activeTextEditor = undefined;
          onDidChangeActiveEditor.fire(undefined);
          break;
        }

        // Get or create the TextDocument with cached content
        let doc = openDocuments.get(params.uri);
        if (!doc) {
          doc = new TextDocument(
            Uri.file(params.uri),
            params.languageId || 'plaintext',
            params.version || 1,
            params.text || '',
          );
          openDocuments.set(params.uri, doc);
        } else if (params.text != null) {
          doc._update(params.text, params.version || doc.version + 1);
        }

        // Build the TextEditor
        const sel = params.selection;
        const selection = sel
          ? new Selection(sel.anchor.line, sel.anchor.character, sel.active.line, sel.active.character)
          : new Selection(0, 0, 0, 0);

        _activeTextEditor = {
          document: doc,
          selection,
          selections: [selection],
          options: {
            tabSize: params.options?.tabSize ?? 2,
            insertSpaces: params.options?.insertSpaces ?? true,
          },
          viewColumn: ViewColumn.One,
          edit: async (callback: (editBuilder: any) => void) => {
            const edits: any[] = [];
            const editBuilder = {
              replace(range: Range, newText: string) { edits.push({ range, newText }); },
              insert(position: Position, newText: string) { edits.push({ range: new Range(position, position), newText }); },
              delete(range: Range) { edits.push({ range, newText: '' }); },
            };
            callback(editBuilder);
            // Send edits back to the frontend
            if (edits.length > 0) {
              bridge.send({
                jsonrpc: '2.0',
                method: 'textDocument/applyEdits',
                params: {
                  uri: params.uri,
                  edits: edits.map(e => ({
                    range: {
                      start: { line: e.range.start.line, character: e.range.start.character },
                      end: { line: e.range.end.line, character: e.range.end.character },
                    },
                    newText: e.newText,
                  })),
                },
              });
            }
            return true;
          },
          revealRange: () => {},
          // Phase A: wire decoration application. Bridge translates the
          // ranges + decorationType key into Monaco deltaDecorations on
          // the editor's model. Called from extensions on every render
          // pass (some extensions call this on every edit), so we keep
          // the API fire-and-forget; failures are logged but don't throw.
          setDecorations(decorationType: any, rangesOrOptions: any[]) {
            const typeId = decorationType?._opideTypeId;
            if (!typeId) return;
            const ranges = (rangesOrOptions || []).map((r: any) => {
              const range = r.range || r; // accept either DecorationOptions or Range
              const hover = r.hoverMessage;
              const renderOptions = r.renderOptions;
              return {
                range: {
                  start: { line: range.start.line, character: range.start.character },
                  end: { line: range.end.line, character: range.end.character },
                },
                hoverMessage: hover,
                renderOptions,
              };
            });
            rpcRequest('decorations/setDecorations', {
              uri: params.uri,
              typeId,
              ranges,
            }).catch((e) => bridge.log(`setDecorations failed: ${e}`));
          },
        };

        bridge.log(`activeTextEditor set: ${params.uri} (${doc.lineCount} lines, ${doc.languageId})`);
        onDidChangeActiveEditor.fire(_activeTextEditor);
        break;
      }
    }
  }

  // ─── The vscode namespace ────────────────────────────────────────────────

  const api = {
    // ── Data types ─────────────────────────────────────────────────────
    Position,
    Range,
    Uri,
    Selection,
    Diagnostic,
    DiagnosticSeverity,
    StatusBarAlignment,
    ViewColumn,
    ConfigurationTarget,
    TextEditorRevealType,
    CompletionItemKind,
    TextEdit,
    TextDocument,
    // Phase A: decoration enums
    OverviewRulerLane,
    DecorationRangeBehavior,
    TextEditorCursorStyle,

    // ── workspace ──────────────────────────────────────────────────────
    workspace: {
      workspaceFolders: workspacePath
        ? [{ uri: Uri.file(workspacePath), name: path.basename(workspacePath), index: 0 }]
        : undefined,

      rootPath: workspacePath || undefined,

      getConfiguration(section?: string) {
        // Known configuration defaults for extensions running in OPIDE
        const knownDefaults: Record<string, Record<string, any>> = {
          prettier: { enable: true, tabWidth: 2, singleQuote: true, semi: true },
          editor: { tabSize: 2, insertSpaces: true, formatOnSave: false },
          todohighlight: {
            isEnable: true,
            isCaseSensitive: true,
            keywords: ['TODO:', 'FIXME:', 'HACK:', 'BUG:', 'XXX:'],
            defaultStyle: { color: '#ffab00', backgroundColor: 'rgba(255,171,0,0.2)' },
            include: ['**/*.js', '**/*.ts', '**/*.tsx', '**/*.jsx', '**/*.rs', '**/*.py', '**/*.go', '**/*.css'],
            exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
            maxFilesForSearch: 5120,
            toggleURI: '',
          },
          eslint: { enable: true, run: 'onType', format: { enable: false } },
          stylelint: { enable: true },
        };

        return {
          get<T>(key: string, defaultValue?: T): T {
            // Check known defaults first (extension configs that must return real values)
            const sectionDefaults = section ? knownDefaults[section] : undefined;
            if (sectionDefaults && key in sectionDefaults) {
              return sectionDefaults[key] as T;
            }
            // For *.enable keys, default to true (extensions should be enabled)
            if (key === 'enable' && defaultValue === undefined) {
              return true as T;
            }
            return defaultValue as T;
          },
          has(key: string): boolean {
            const sectionDefaults = section ? knownDefaults[section] : undefined;
            return !!(sectionDefaults && key in sectionDefaults);
          },
          update(key: string, value: any, target?: ConfigurationTarget): Promise<void> {
            return rpcRequest('configuration/update', { section, key, value, target });
          },
          inspect(key: string) { return undefined; },
        };
      },

      async openTextDocument(uriOrPath: Uri | string): Promise<any> {
        const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
        return rpcRequest('workspace/openTextDocument', { path: fsPath });
      },

      async findFiles(include: string, exclude?: string, maxResults?: number): Promise<Uri[]> {
        const result = await rpcRequest('workspace/findFiles', { include, exclude, maxResults });
        return (result || []).map((p: string) => Uri.file(p));
      },

      createFileSystemWatcher(pattern: string) {
        const onChange = new VSCodeEvent<Uri>('onChange');
        const onCreate = new VSCodeEvent<Uri>('onCreate');
        const onDelete = new VSCodeEvent<Uri>('onDelete');
        // Tell OPIDE to watch this pattern
        rpcRequest('workspace/watchFiles', { pattern }).catch(() => {});
        return {
          onDidChange: onChange.event,
          onDidCreate: onCreate.event,
          onDidDelete: onDelete.event,
          dispose: () => {},
        };
      },

      onDidChangeTextDocument: onDidChangeTextDoc.event,
      onDidOpenTextDocument: onDidOpenTextDoc.event,
      onDidCloseTextDocument: onDidCloseTextDoc.event,
      onDidSaveTextDocument: onDidSaveTextDoc.event,
      onDidChangeConfiguration: onDidChangeConfig.event,

      fs: {
        async readFile(uri: Uri): Promise<Uint8Array> {
          const result = await rpcRequest('fs/readFile', { path: uri.fsPath });
          return Buffer.from(result, 'base64');
        },
        async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
          await rpcRequest('fs/writeFile', { path: uri.fsPath, content: Buffer.from(content).toString('base64') });
        },
        async stat(uri: Uri): Promise<any> {
          return rpcRequest('fs/stat', { path: uri.fsPath });
        },
        async readDirectory(uri: Uri): Promise<[string, number][]> {
          return rpcRequest('fs/readDirectory', { path: uri.fsPath });
        },
        async delete(uri: Uri): Promise<void> {
          await rpcRequest('fs/delete', { path: uri.fsPath });
        },
        async createDirectory(uri: Uri): Promise<void> {
          await rpcRequest('fs/createDirectory', { path: uri.fsPath });
        },
      },
    },

    // ── window ─────────────────────────────────────────────────────────
    window: {
      get activeTextEditor() { return _activeTextEditor; },
      set activeTextEditor(v: any) { _activeTextEditor = v; },

      onDidChangeActiveTextEditor: onDidChangeActiveEditor.event,

      showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return rpcRequest('window/showMessage', { type: 'info', message, items });
      },
      showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return rpcRequest('window/showMessage', { type: 'warning', message, items });
      },
      showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
        return rpcRequest('window/showMessage', { type: 'error', message, items });
      },
      showQuickPick(items: any[], options?: any): Promise<any> {
        return rpcRequest('window/showQuickPick', { items, options });
      },
      showInputBox(options?: any): Promise<string | undefined> {
        return rpcRequest('window/showInputBox', { options });
      },

      createOutputChannel(name: string) {
        const lines: string[] = [];
        outputChannels.set(name, lines);
        return {
          name,
          append(value: string) {
            lines.push(value);
            // Stream incremental output to the panel so it scrolls live
            // instead of only filling on show(). Most extensions append
            // continuously while a long task runs (lint, build, test).
            rpcRequest('window/showOutputChannel', {
              name, content: value, append: true, show: false,
            }).catch(() => {});
          },
          appendLine(value: string) {
            const line = value + '\n';
            lines.push(line);
            rpcRequest('window/showOutputChannel', {
              name, content: line, append: true, show: false,
            }).catch(() => {});
          },
          clear() {
            lines.length = 0;
            rpcRequest('window/showOutputChannel', {
              name, content: '', append: false, show: false,
            }).catch(() => {});
          },
          show() {
            // Phase A.A3: pass show: true so the bridge actually opens
            // the Output panel pinned to this channel. Previously the
            // bridge received the message but had no `show` flag set,
            // so it silently no-op'd.
            rpcRequest('window/showOutputChannel', {
              name, content: lines.join(''), append: false, show: true,
            }).catch(() => {});
          },
          hide() {},
          dispose() { outputChannels.delete(name); },
        };
      },

      createStatusBarItem(alignment?: StatusBarAlignment, priority?: number) {
        let _text = '';
        let _tooltip = '';
        let _command: string | undefined;
        let _visible = false;
        return {
          get text() { return _text; },
          set text(v: string) { _text = v; this._update(); },
          get tooltip() { return _tooltip; },
          set tooltip(v: string) { _tooltip = v; },
          get command() { return _command; },
          set command(v: string | undefined) { _command = v; },
          alignment: alignment || StatusBarAlignment.Left,
          priority: priority || 0,
          show() { _visible = true; this._update(); },
          hide() { _visible = false; this._update(); },
          dispose() { _visible = false; this._update(); },
          _update() {
            rpcRequest('window/statusBarItem', {
              text: _text, tooltip: _tooltip, command: _command,
              visible: _visible, alignment, priority,
            }).catch(() => {});
          },
        };
      },

      showTextDocument(doc: any, column?: ViewColumn) {
        return rpcRequest('window/showTextDocument', { uri: doc?.uri?.fsPath || doc, column });
      },

      // Phase A.A1: real webview panel backed by an iframe in the OPIDE
      // workbench. The bridge mounts the iframe, injects html, and routes
      // postMessage in both directions. Each panel gets a unique panelId
      // we use as the addressing key for all RPC calls.
      createWebviewPanel(viewType: string, title: string, showOptions: any, options?: any) {
        const panelId = `panel-${_nextPanelId++}`;
        const onDidReceiveMessageEvent = new VSCodeEvent<any>('webview/messageFromWebview');
        const onDidDisposeEvent = new VSCodeEvent<void>('webview/didDispose');
        const onDidChangeViewStateEvent = new VSCodeEvent<any>('webview/didChangeViewState');

        const panel: WebviewPanelInst = {
          panelId,
          viewType,
          title,
          htmlValue: '',
          onDidReceiveMessageEvent,
          onDidDisposeEvent,
          onDidChangeViewStateEvent,
          disposed: false,
          visible: true,
          active: true,
          extPath: extensionPath,
        };
        _webviewPanels.set(panelId, panel);

        // Tell the bridge to create the iframe panel. showOptions can be
        // a ViewColumn or a {viewColumn, preserveFocus} record.
        const viewColumn = typeof showOptions === 'number'
          ? showOptions
          : (showOptions?.viewColumn ?? ViewColumn.One);
        const preserveFocus = typeof showOptions === 'object'
          ? !!showOptions?.preserveFocus
          : false;

        rpcRequest('webview/create', {
          panelId,
          viewType,
          title,
          viewColumn,
          preserveFocus,
          options: options || {},
          extensionPath,
        }).catch((e) => bridge.log(`webview/create failed: ${e}`));

        const webview = {
          // The html setter pushes the new html to the bridge; the bridge
          // injects it into the iframe via srcdoc with appropriate sandbox
          // attributes derived from `options`.
          get html() { return panel.htmlValue; },
          set html(v: string) {
            panel.htmlValue = v;
            rpcRequest('webview/setHtml', { panelId, html: v }).catch((e) =>
              bridge.log(`webview/setHtml failed: ${e}`),
            );
          },
          // Extension-provided options { enableScripts, retainContextWhenHidden, ... }
          options: options?.webviewOptions || {},
          // postMessage extension → webview. Returns Promise<boolean> per
          // VS Code contract; we resolve to true on dispatch.
          postMessage: (message: any): Promise<boolean> => {
            return rpcRequest('webview/postMessage', { panelId, message })
              .then(() => true)
              .catch(() => false);
          },
          // Extensions register a listener; the bridge fires events when
          // the iframe sends `window.parent.postMessage(...)`.
          onDidReceiveMessage: onDidReceiveMessageEvent.event,
          // asWebviewUri converts a local fs URI to one the webview can
          // load. Until we have a custom protocol handler we map fs paths
          // to a `vscode-resource://` style URI; the bridge intercepts.
          asWebviewUri(uri: Uri) {
            return Uri.parse(`vscode-resource://${uri.fsPath}`);
          },
          // CSP source that the extension can include in its <meta http-equiv="Content-Security-Policy">
          cspSource: 'vscode-resource:',
        };

        const wp = {
          webview,
          viewType,
          title,
          options: options || {},
          viewColumn,
          active: true,
          visible: true,
          onDidDispose: onDidDisposeEvent.event,
          onDidChangeViewState: onDidChangeViewStateEvent.event,
          reveal(column?: ViewColumn, preserveFocusFlag?: boolean) {
            rpcRequest('webview/reveal', {
              panelId,
              viewColumn: column,
              preserveFocus: !!preserveFocusFlag,
            }).catch((e) => bridge.log(`webview/reveal failed: ${e}`));
          },
          dispose() {
            if (panel.disposed) return;
            panel.disposed = true;
            _webviewPanels.delete(panelId);
            rpcRequest('webview/dispose', { panelId }).catch(() => {});
            onDidDisposeEvent.fire(undefined as any);
          },
        };

        return wp;
      },

      // Phase A.A2: decoration type registration. The extension calls
      // this once with a set of render options; we allocate an opaque
      // typeId and tell the bridge to translate the options into the
      // Monaco IModelDeltaDecoration shape on first setDecorations call.
      createTextEditorDecorationType(options: any) {
        const typeId = `dec-${_nextDecorationTypeId++}`;
        _decorationTypes.set(typeId, options);
        rpcRequest('decorations/createType', { typeId, options }).catch((e) =>
          bridge.log(`decorations/createType failed: ${e}`),
        );
        return {
          key: typeId,
          // Internal key the editor's setDecorations reads to address
          // the type when sending range data over RPC.
          _opideTypeId: typeId,
          dispose() {
            _decorationTypes.delete(typeId);
            rpcRequest('decorations/disposeType', { typeId }).catch(() => {});
          },
        };
      },
    },

    // ── commands ────────────────────────────────────────────────────────
    commands: {
      registerCommand(command: string, callback: (...args: any[]) => any): { dispose(): void } {
        commandRegistry.set(command, callback);
        // Tell OPIDE about this command so it appears in the command palette
        rpcRequest('commands/register', { command }).catch(() => {});
        return {
          dispose: () => { commandRegistry.delete(command); },
        };
      },

      async executeCommand<T>(command: string, ...args: any[]): Promise<T> {
        // Check local registry first
        if (commandRegistry.has(command)) {
          return commandRegistry.get(command)!(...args);
        }
        // Otherwise forward to OPIDE
        return rpcRequest('commands/execute', { command, args });
      },

      getCommands(filterInternal?: boolean): Promise<string[]> {
        return rpcRequest('commands/list', { filterInternal });
      },
    },

    // ── languages ──────────────────────────────────────────────────────
    languages: {
      createDiagnosticCollection(name: string) {
        const diags = new Map<string, Diagnostic[]>();
        diagnosticCollections.set(name, diags);
        return {
          name,
          set(uri: Uri, diagnostics: Diagnostic[]) {
            diags.set(uri.fsPath, diagnostics);
            rpcRequest('languages/publishDiagnostics', {
              uri: uri.fsPath,
              diagnostics: diagnostics.map((d) => ({
                range: { start: { line: d.range.start.line, character: d.range.start.character },
                         end: { line: d.range.end.line, character: d.range.end.character } },
                message: d.message,
                severity: d.severity,
                source: d.source,
                code: d.code,
              })),
            }).catch(() => {});
          },
          delete(uri: Uri) { diags.delete(uri.fsPath); },
          clear() { diags.clear(); },
          has(uri: Uri) { return diags.has(uri.fsPath); },
          get(uri: Uri) { return diags.get(uri.fsPath); },
          forEach(callback: (uri: Uri, diags: Diagnostic[]) => void) {
            diags.forEach((d, p) => callback(Uri.file(p), d));
          },
          dispose() { diagnosticCollections.delete(name); },
        };
      },

      registerCompletionItemProvider(selector: any, provider: any, ...triggerChars: string[]) {
        rpcRequest('languages/registerCompletionProvider', {
          selector, triggerCharacters: triggerChars,
        }).catch(() => {});
        return { dispose: () => {} };
      },

      registerHoverProvider(selector: any, provider: any) {
        rpcRequest('languages/registerHoverProvider', { selector }).catch(() => {});
        return { dispose: () => {} };
      },

      registerDefinitionProvider(selector: any, provider: any) {
        rpcRequest('languages/registerDefinitionProvider', { selector }).catch(() => {});
        return { dispose: () => {} };
      },

      registerCodeActionsProvider(selector: any, provider: any, metadata?: any) {
        rpcRequest('languages/registerCodeActionsProvider', { selector }).catch(() => {});
        return { dispose: () => {} };
      },

      registerDocumentFormattingEditProvider(selector: any, provider: any) {
        rpcRequest('languages/registerFormattingProvider', { selector }).catch(() => {});
        return { dispose: () => {} };
      },

      match(selector: any, document: any): number {
        return 1; // Simplified — always match
      },

      getDiagnostics(resource?: Uri): any[] {
        return [];
      },
    },

    // ── extensions ─────────────────────────────────────────────────────
    extensions: {
      all: [] as any[],
      getExtension(id: string): any | undefined {
        return undefined; // Will be populated after activation
      },
      onDidChange: new VSCodeEvent<void>('onDidChange').event,
    },

    // ── env ─────────────────────────────────────────────────────────────
    env: {
      appName: 'OPIDE',
      appRoot: workspacePath,
      language: 'en',
      machineId: 'opide-local',
      sessionId: `opide-${Date.now()}`,
      uriScheme: 'opide',
      clipboard: {
        readText: () => rpcRequest('env/clipboardRead', {}),
        writeText: (text: string) => rpcRequest('env/clipboardWrite', { text }),
      },
      openExternal: (uri: Uri) => rpcRequest('env/openExternal', { uri: uri.toString() }),
    },

    // ── ExtensionContext (passed to activate) ─────────────────────────
    _createContext(extensionId: string, extPath: string) {
      const storagePath = path.join(workspacePath, '.opide', 'extension-storage', extensionId);
      const globalStoragePath = path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        '.opide', 'extension-global-storage', extensionId
      );
      return {
        subscriptions: disposables,
        extensionPath: extPath,
        extensionUri: Uri.file(extPath),
        storagePath,
        storageUri: Uri.file(storagePath),
        globalStoragePath,
        globalStorageUri: Uri.file(globalStoragePath),
        logPath: path.join(storagePath, 'logs'),
        logUri: Uri.file(path.join(storagePath, 'logs')),
        extensionMode: 1, // Production
        workspaceState: createMemento(),
        globalState: createMemento(),
        secrets: {
          get: (key: string) => rpcRequest('secrets/get', { extensionId, key }),
          store: (key: string, value: string) => rpcRequest('secrets/store', { extensionId, key, value }),
          delete: (key: string) => rpcRequest('secrets/delete', { extensionId, key }),
          onDidChange: new VSCodeEvent<any>('onDidChange').event,
        },
        asAbsolutePath: (relativePath: string) => path.join(extPath, relativePath),
      };
    },
  };

  return api;
}

// Simple in-memory memento (persists within session, not across restarts yet)
function createMemento() {
  const store = new Map<string, any>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return store.has(key) ? store.get(key) : (defaultValue as T);
    },
    update(key: string, value: any): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return [...store.keys()];
    },
    setKeysForSync(keys: string[]): void {},
  };
}
