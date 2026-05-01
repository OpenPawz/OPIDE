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

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}

// Phase C: VS Code's public EventEmitter has the same surface as our
// internal VSCodeEvent — fire(data), event (function-shaped subscriber),
// dispose(). Expose a class so extensions that do
// `new vscode.EventEmitter<T>()` get a working object back.
class VSCodeEventEmitter<T> extends VSCodeEvent<T> {
  constructor() { super('extension'); }
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

/**
 * Compute the webview-resource URL for a local fsPath. Mirrors the
 * algorithm in monaco-vscode-api's
 * vs/workbench/contrib/webview/common/webview.js#asWebviewUri so the
 * URL we hand to the extension matches the format the workbench
 * webview's service worker recognises and routes to localResourceRoots.
 *
 * For a `file:///path/to/foo` URI:
 *   https://file+.vscode-resource.vscode-cdn.net/path/to/foo
 */
function fsPathToWebviewUrl(fsPath: string): string {
  if (!fsPath) return '';
  // Normalise to forward slashes; ensure leading slash.
  let p = fsPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return `https://file+.vscode-resource.vscode-cdn.net${p}`;
}

/** CSP source matching the webview-resource URLs above. Extensions
 * template `${webview.cspSource}` into their CSP meta tag. */
const WEBVIEW_CSP_SOURCE = "'self' https://*.vscode-cdn.net";

// ── Coding-agent API surface ────────────────────────────────────────────
// These classes / enums / values are accessed at module-load time by every
// modern coding-agent extension (Claude Code, Continue, Cline, Cody, Copilot,
// Tabnine). Missing any of them throws synchronously inside activate() before
// the extension can register anything. Comprehensive shim batch — built
// against a static analysis of Anthropic.claude-code's extension.js plus the
// next layer of common patterns Continue/Cline use.

/** `vscode.Disposable` — extensions construct via `Disposable.from(...)` and
 * subclass; we just need a class with a callable dispose. */
class VsCodeDisposable {
  constructor(private _onDispose?: () => void) {}
  dispose(): void { try { this._onDispose?.() } catch { /* ignore */ } }
  static from(...disposables: { dispose(): void }[]): VsCodeDisposable {
    return new VsCodeDisposable(() => {
      for (const d of disposables) { try { d.dispose() } catch { /* ignore */ } }
    });
  }
}

/** `vscode.FileType` and `FileChangeType` — bitflag enums used by the file
 * system provider API. Values match the public VS Code API contract. */
enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }

/** `vscode.FileSystemError` — extensions construct these in their own fs
 * provider implementations. The static factories return Error subclasses
 * with a `.code` property the workbench introspects. */
class FileSystemError extends Error {
  code: string;
  constructor(messageOrUri?: any, code: string = 'Unknown') {
    super(typeof messageOrUri === 'string' ? messageOrUri : (messageOrUri?.toString?.() ?? code));
    this.code = code;
    this.name = 'FileSystemError';
  }
  static FileNotFound(messageOrUri?: any) { return new FileSystemError(messageOrUri, 'FileNotFound'); }
  static FileExists(messageOrUri?: any) { return new FileSystemError(messageOrUri, 'FileExists'); }
  static FileNotADirectory(messageOrUri?: any) { return new FileSystemError(messageOrUri, 'FileNotADirectory'); }
  static FileIsADirectory(messageOrUri?: any) { return new FileSystemError(messageOrUri, 'FileIsADirectory'); }
  static NoPermissions(messageOrUri?: any) { return new FileSystemError(messageOrUri, 'NoPermissions'); }
  static Unavailable(messageOrUri?: any) { return new FileSystemError(messageOrUri, 'Unavailable'); }
}

/** `vscode.TabInputText`, `TabInputTextDiff`, etc — value classes the
 * workbench's tab API exposes. Minimal stubs so `instanceof` checks
 * extensions perform don't blow up. */
class TabInputText { constructor(public uri: any) {} }
class TabInputTextDiff { constructor(public original: any, public modified: any) {} }
class TabInputCustom { constructor(public uri: any, public viewType: string) {} }
class TabInputWebview { constructor(public viewType: string) {} }
class TabInputNotebook { constructor(public uri: any, public notebookType: string) {} }
class TabInputNotebookDiff { constructor(public original: any, public modified: any, public notebookType: string) {} }
class TabInputTerminal {}

enum LogLevel { Off = 0, Trace = 1, Debug = 2, Info = 3, Warning = 4, Error = 5 }

/** `vscode.MarkdownString` — used for hover content / chat content. */
class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value: string) { this.value += value; return this; }
  appendMarkdown(value: string) { this.value += value; return this; }
  appendCodeblock(code: string, language?: string) {
    this.value += `\n\`\`\`${language || ''}\n${code}\n\`\`\`\n`;
    return this;
  }
}

/** `vscode.Hover` — returned by hover providers. */
class Hover {
  constructor(public contents: any[], public range?: any) {
    if (!Array.isArray(contents)) this.contents = [contents];
  }
}

/** `vscode.CodeActionKind` is a hierarchical category string-ish object.
 * We model the common kinds as instances; constructor accepts a string. */
class CodeActionKind {
  constructor(public value: string) {}
  append(parts: string): CodeActionKind { return new CodeActionKind(`${this.value}.${parts}`); }
  intersects(other: CodeActionKind): boolean { return other.value.startsWith(this.value) || this.value.startsWith(other.value); }
  contains(other: CodeActionKind): boolean { return other.value.startsWith(this.value); }
  static readonly Empty = new CodeActionKind('');
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly Refactor = new CodeActionKind('refactor');
  static readonly RefactorExtract = new CodeActionKind('refactor.extract');
  static readonly RefactorInline = new CodeActionKind('refactor.inline');
  static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
  static readonly Source = new CodeActionKind('source');
  static readonly SourceOrganizeImports = new CodeActionKind('source.organizeImports');
  static readonly SourceFixAll = new CodeActionKind('source.fixAll');
  static readonly Notebook = new CodeActionKind('notebook');
}

class CodeAction {
  edit?: any; diagnostics?: any[]; command?: any; isPreferred?: boolean;
  constructor(public title: string, public kind: CodeActionKind = CodeActionKind.Empty) {}
}

/** `vscode.SnippetString`, `vscode.WorkspaceEdit` — common refactor APIs. */
class SnippetString {
  value: string;
  constructor(value = '') { this.value = value; }
  appendText(s: string) { this.value += s.replace(/\$/g, '\\$'); return this; }
  appendTabstop(n?: number) { this.value += `$${n ?? 0}`; return this; }
  appendPlaceholder(value: string, n?: number) { this.value += `\${${n ?? 0}:${value}}`; return this; }
  appendChoice(values: string[], n?: number) { this.value += `\${${n ?? 0}|${values.join(',')}|}`; return this; }
  appendVariable(name: string, defaultValue?: string) {
    this.value += defaultValue ? `\${${name}:${defaultValue}}` : `\${${name}}`;
    return this;
  }
}

class WorkspaceEdit {
  private _edits: any[] = [];
  replace(uri: any, range: any, newText: string) { this._edits.push({ kind: 'replace', uri, range, newText }); }
  insert(uri: any, position: any, newText: string) { this._edits.push({ kind: 'insert', uri, position, newText }); }
  delete(uri: any, range: any) { this._edits.push({ kind: 'delete', uri, range }); }
  has(uri: any) { return this._edits.some((e) => e.uri === uri); }
  get size(): number { return this._edits.length; }
  entries() { return this._edits.map((e) => [e.uri, [e]]); }
  set(uri: any, edits: any[]) { this._edits = this._edits.filter((e) => e.uri !== uri).concat(edits); }
  get(uri: any) { return this._edits.filter((e) => e.uri === uri); }
  createFile() { /* TODO */ }
  deleteFile() { /* TODO */ }
  renameFile() { /* TODO */ }
}

enum SymbolKind {
  File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4, Method = 5,
  Property = 6, Field = 7, Constructor = 8, Enum = 9, Interface = 10,
  Function = 11, Variable = 12, Constant = 13, String = 14, Number = 15,
  Boolean = 16, Array = 17, Object = 18, Key = 19, Null = 20, EnumMember = 21,
  Struct = 22, Event = 23, Operator = 24, TypeParameter = 25,
}

class SymbolInformation {
  constructor(public name: string, public kind: SymbolKind, public containerName: string, public location: any) {}
}

class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(public name: string, public detail: string, public kind: SymbolKind, public range: any, public selectionRange: any) {}
}

// Phase H surface: NotebookCellOutputItem is a top-level class even
// for extensions that don't otherwise touch notebooks (Claude Code's
// activation builds a sentinel value via
// `NotebookCellOutputItem.error(Error("")).mime` to discover the
// runtime's MIME type for serialised errors). Missing class throws
// during activation; minimal shim with the static factories satisfies
// the common access patterns.
class NotebookCellOutputItem {
  constructor(public data: Uint8Array, public mime: string) {}
  static text(value: string, mime: string = 'text/plain'): NotebookCellOutputItem {
    const buf = (typeof Buffer !== 'undefined')
      ? Buffer.from(value, 'utf-8')
      : new TextEncoder().encode(value);
    return new NotebookCellOutputItem(buf as any, mime);
  }
  static json(value: any, mime: string = 'application/json'): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(JSON.stringify(value), mime);
  }
  static error(err: Error): NotebookCellOutputItem {
    const payload = JSON.stringify({
      name: err?.name ?? 'Error',
      message: err?.message ?? '',
      stack: err?.stack ?? '',
    });
    return NotebookCellOutputItem.text(payload, 'application/vnd.code.notebook.error');
  }
  static stdout(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stdout');
  }
  static stderr(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stderr');
  }
}

class NotebookCellOutput {
  constructor(public items: NotebookCellOutputItem[], public metadata?: any) {}
}

// Phase D: debug enums + descriptor types
enum DebugConsoleMode { Separate = 0, MergeWithParent = 1 }
class DebugAdapterExecutable {
  constructor(
    public readonly command: string,
    public readonly args?: string[],
    public readonly options?: any,
  ) {}
}
class DebugAdapterServer {
  constructor(public readonly port: number, public readonly host?: string) {}
}
class DebugAdapterNamedPipeServer {
  constructor(public readonly path: string) {}
}
class DebugAdapterInlineImplementation {
  constructor(public readonly implementation: any) {}
}
class SourceBreakpoint {
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  constructor(public location: any, enabled = true, condition?: string, hitCondition?: string, logMessage?: string) {
    this.enabled = enabled;
    this.condition = condition;
    this.hitCondition = hitCondition;
    this.logMessage = logMessage;
  }
}
class FunctionBreakpoint {
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  constructor(public functionName: string, enabled = true, condition?: string, hitCondition?: string, logMessage?: string) {
    this.enabled = enabled;
    this.condition = condition;
    this.hitCondition = hitCondition;
    this.logMessage = logMessage;
  }
}

// Phase C: tree view + webview view enums
enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: any) {}
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
}
class ThemeColor {
  constructor(public readonly id: string) {}
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

    // P1: incoming requests from the workbench. Used by language
    // providers that proxy to extensions — e.g. Monaco asks the
    // sidecar for inline completions, the sidecar dispatches to the
    // registered provider, and we reply on the same id.
    if (msg.method && msg.id && !pendingRequests.has(msg.id)) {
      handleRequest(msg.method, msg.params, msg.id).catch((err: any) => {
        bridge.send({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -1, message: err?.message || 'request failed' },
        });
      });
    }
  });

  /** Dispatch an incoming bridge → sidecar request. Currently handles
   * the inline-completion callback; future extensions of this list
   * can wire other language providers (completion / hover /
   * definition / etc) end-to-end. */
  async function handleRequest(method: string, params: any, id: number): Promise<void> {
    if (method === 'languages/provideInlineCompletionItems') {
      const items = await provideInlineCompletions(params);
      bridge.send({ jsonrpc: '2.0', id, result: { items } });
      return;
    }
    // Unknown — respond with null so the caller doesn't time out.
    bridge.send({ jsonrpc: '2.0', id, result: null });
  }

  /** Walk every registered inline completion provider whose selector
   * matches the requested language, call its provideInlineCompletionItems
   * with a faux TextDocument + Position, and merge the results.
   *
   * Returns an array of { insertText, range, command? } shaped to what
   * Monaco's InlineCompletionProvider expects after the bridge unwraps. */
  async function provideInlineCompletions(params: any): Promise<any[]> {
    const { uri, position, languageId, context } = params || {};
    const merged: any[] = [];
    for (const rec of _inlineCompletionProviders.values()) {
      const matches =
        rec.languages.includes(languageId) || rec.languages.includes('*');
      if (!matches) continue;

      // Build minimal vscode.TextDocument + Position for the call.
      let doc = openDocuments.get(uri);
      if (!doc) {
        // Fall back: read from disk via OPIDE's fs/readFile RPC.
        try {
          const text = await rpcRequest('fs/readFile', { path: uri });
          const decoded = typeof text === 'string'
            ? Buffer.from(text, 'base64').toString('utf-8')
            : '';
          doc = new TextDocument(Uri.file(uri), languageId || 'plaintext', 1, decoded);
          openDocuments.set(uri, doc);
        } catch {
          continue;
        }
      }
      const pos = new Position(position?.line ?? 0, position?.character ?? 0);
      const cancel = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      };
      try {
        const r = await Promise.resolve(
          rec.provider.provideInlineCompletionItems?.(doc, pos, context || {}, cancel),
        );
        const list = Array.isArray(r) ? r : (r?.items || []);
        for (const item of list) {
          merged.push({
            insertText: typeof item.insertText === 'string'
              ? item.insertText
              : (item.insertText?.value || ''),
            range: serializeRange(item.range, pos),
            command: item.command ? {
              command: item.command.command,
              title: item.command.title,
              arguments: item.command.arguments,
            } : undefined,
          });
        }
      } catch (e: any) {
        bridge.log(`inline completion provider failed: ${e?.message || e}`);
      }
    }
    return merged;
  }

  /** Serialize a Range to the wire shape the bridge expects, defaulting
   * to a zero-width range at the cursor if the provider didn't supply one. */
  function serializeRange(range: any, fallbackPos: any): any {
    if (range?.start && range?.end) {
      return {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
      };
    }
    return {
      start: { line: fallbackPos.line, character: fallbackPos.character },
      end: { line: fallbackPos.line, character: fallbackPos.character },
    };
  }

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

  // ── Extension registry (for vscode.extensions.getExtension) ──────────
  // bootstrap.ts populates this with every scanned extension AFTER
  // scan completes; before that the registry is empty. Each value is a
  // record we shape into a public Extension on read. We don't track
  // active state here — the workbench owns lifecycle.
  interface ExtRegistryRec {
    id: string;
    extensionPath: string;
    extensionUri: any;
    packageJSON: any;
    isActive: boolean;
    exports: any;
  }
  const _extensionRegistry = new Map<string, ExtRegistryRec>();
  /** Set by bootstrap before/after activate(ext) so api-shim calls made
   * synchronously inside activate (registerWebviewViewProvider,
   * createWebviewPanel, etc.) can attribute themselves to the right
   * extension — needed to compute resource roots / origin keys. */
  let _currentExtensionId: string | null = null;
  let _currentExtensionPath: string | null = null;
  /** Case-insensitive registry lookup. VS Code extension IDs are
   * compared case-insensitively even though they're stored
   * case-preserving. Claude Code self-references with the same case it
   * declares in package.json so this rarely matters, but Cline/Continue
   * sometimes lowercase. */
  function lookupExtensionRec(id: string): ExtRegistryRec | undefined {
    if (!id) return undefined;
    const direct = _extensionRegistry.get(id);
    if (direct) return direct;
    const lower = id.toLowerCase();
    for (const [k, v] of _extensionRegistry) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  function toPublicExtension(rec: ExtRegistryRec): any {
    return {
      id: rec.id,
      extensionPath: rec.extensionPath,
      extensionUri: rec.extensionUri,
      packageJSON: rec.packageJSON,
      isActive: rec.isActive,
      exports: rec.exports,
      activate: () => Promise.resolve(rec.exports),
      extensionKind: 1, // ExtensionKind.UI
    };
  }

  // ── P1 registries ─────────────────────────────────────────────────────
  interface InlineCompletionProviderRec {
    provider: any;
    languages: string[];
    selector: any;
  }
  const _inlineCompletionProviders = new Map<string, InlineCompletionProviderRec>();
  let _nextInlineCompletionId = 1;

  /** VS Code DocumentSelector accepts strings, arrays, or objects with
   * `language`, `scheme`, `pattern`. We flatten into a list of language
   * IDs so the bridge can register Monaco providers per language; '*'
   * means "all languages" and is preserved through. */
  function selectorToLanguageIds(selector: any): string[] {
    if (typeof selector === 'string') return [selector];
    if (Array.isArray(selector)) {
      const out: string[] = [];
      for (const s of selector) out.push(...selectorToLanguageIds(s));
      return out;
    }
    if (selector && typeof selector === 'object' && selector.language) {
      return [selector.language];
    }
    return ['*'];
  }

  // ── Phase D registries ────────────────────────────────────────────────
  interface DebugAdapterFactoryInst { type: string; factory: any }
  interface DebugConfigProviderInst { type: string; provider: any; trigger?: number }
  const _debugAdapterFactories = new Map<string, DebugAdapterFactoryInst>();
  const _debugConfigProviders = new Map<string, DebugConfigProviderInst[]>();
  const _activeDebugSessions = new Map<string, any>();
  const onDidStartDebugSession = new VSCodeEvent<any>('onDidStartDebugSession');
  const onDidTerminateDebugSession = new VSCodeEvent<any>('onDidTerminateDebugSession');
  const onDidChangeActiveDebugSession = new VSCodeEvent<any>('onDidChangeActiveDebugSession');
  const onDidChangeBreakpoints = new VSCodeEvent<any>('onDidChangeBreakpoints');
  const onDidReceiveDebugSessionCustomEvent = new VSCodeEvent<any>('onDidReceiveDebugSessionCustomEvent');
  let _activeDebugSession: any = undefined;
  const _breakpoints: any[] = [];

  // ── Phase E registries ────────────────────────────────────────────────
  interface TaskProviderInst { type: string; provider: any }
  const _taskProviders = new Map<string, TaskProviderInst>();
  const _terminals = new Map<string, any>();
  let _nextTerminalId = 1;
  const onDidOpenTerminal = new VSCodeEvent<any>('onDidOpenTerminal');
  const onDidCloseTerminal = new VSCodeEvent<any>('onDidCloseTerminal');
  const onDidStartTask = new VSCodeEvent<any>('onDidStartTask');
  const onDidEndTask = new VSCodeEvent<any>('onDidEndTask');

  // ── Phase F registries ────────────────────────────────────────────────
  interface SourceControlInst {
    id: string; label: string; rootUri?: any;
    inputBox: any; resourceGroups: Map<string, any>;
    quickDiffProvider?: any;
    statusBarCommands?: any[];
    count: number;
  }
  const _sourceControls = new Map<string, SourceControlInst>();
  let _nextScmGroupId = 1;

  // ── Phase G registries ────────────────────────────────────────────────
  interface TestControllerInst {
    id: string; label: string; items: Map<string, any>;
    runProfiles: Map<string, any>;
    refreshHandler?: () => any;
    resolveHandler?: (item: any) => any;
  }
  const _testControllers = new Map<string, TestControllerInst>();
  let _nextTestProfileId = 1;
  let _nextTestRunId = 1;

  // ── Phase I registries ────────────────────────────────────────────────
  interface CustomEditorProviderInst { viewType: string; provider: any }
  const _customEditorProviders = new Map<string, CustomEditorProviderInst>();

  // ── Phase H registries ────────────────────────────────────────────────
  interface NotebookControllerInst {
    id: string; viewType: string; label: string;
    executeHandler?: (cells: any[], notebook: any, controller: any) => any;
    interruptHandler?: (notebook: any) => any;
    supportedLanguages?: string[];
    supportsExecutionOrder?: boolean;
  }
  const _notebookControllers = new Map<string, NotebookControllerInst>();
  const _notebookSerializers = new Map<string, any>();

  // ── Phase C registries ────────────────────────────────────────────────
  // Tree data providers keyed by view id (from contributes.views).
  // Each holds the provider instance + a serialized cache of its current
  // tree so the bridge can avoid round-tripping for unchanged subtrees.
  interface TreeProviderInst {
    viewId: string;
    provider: any;
    onChangeListener?: (e: any) => void;
  }
  const _treeProviders = new Map<string, TreeProviderInst>();
  // Track tree items by a synthetic node id so the bridge can request
  // children of a specific parent without us having to serialize every
  // node identity. Items are reused across getChildren calls; we keep
  // them alive until the next refresh.
  const _treeItems = new Map<string, { provider: TreeProviderInst; element: any; item: any }>();
  let _nextTreeNodeId = 1;
  // Webview view providers (sidebar webviews) keyed by view id.
  interface WebviewViewProvider {
    viewId: string;
    provider: any;
    options: any;
  }
  const _webviewViews = new Map<string, WebviewViewProvider>();
  /** Per-view onDidReceiveMessage emitters. Created in webviewView/resolve
   * and fired in webviewView/messageFromWebview so the extension's
   * onDidReceiveMessage callback actually runs when the webview React
   * app calls vscode.postMessage(...). Without this the webview is mute
   * to the extension and never gets initial state. */
  const _webviewViewMessageEmitters = new Map<string, VSCodeEvent<any>>();
  const _webviewViewDisposeEmitters = new Map<string, VSCodeEvent<void>>();

  // ── Phase B registries ────────────────────────────────────────────────
  // Chat participants: extensions register handlers here; OPIDE's chat
  // panel catches @<id> prefixes and dispatches user messages to the
  // matching handler. Streaming chunks travel the other way as
  // notifications keyed on the dispatch's requestId.
  interface ParticipantInst {
    id: string;
    handler: (request: any, context: any, stream: any, token: any) => any;
    options: any;
    iconPath?: any;
  }
  const _chatParticipants = new Map<string, ParticipantInst>();
  // Authentication providers registered by extensions (separate from the
  // built-in providers that OPIDE itself wires up at the bridge layer).
  const _authProviders = new Map<string, any>();

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

      // ── Phase C: tree-view children request ────────────────────────
      // The OPIDE sidebar asks for nodes under a parent (or root if
      // parentNodeId is undefined). We resolve through the matching
      // provider's getChildren / getTreeItem and reply via the request
      // id the bridge supplied.
      case 'tree/getChildren': {
        (async () => {
          const { viewId, parentNodeId, requestId } = params || {};
          const inst = _treeProviders.get(viewId);
          if (!inst) {
            bridge.send({
              jsonrpc: '2.0', method: 'tree/childrenResponse',
              params: { requestId, items: [] },
            });
            return;
          }
          let parentElement: any = undefined;
          if (parentNodeId && _treeItems.has(parentNodeId)) {
            parentElement = _treeItems.get(parentNodeId)!.element;
          }
          let children: any[] = [];
          try {
            const r = inst.provider.getChildren?.(parentElement);
            children = (await Promise.resolve(r)) || [];
          } catch (e: any) {
            bridge.log(`tree.getChildren(${viewId}) failed: ${e?.message || e}`);
          }
          const items = await Promise.all(children.map(async (el: any) => {
            let treeItem: any = {};
            try {
              treeItem = (await Promise.resolve(inst.provider.getTreeItem?.(el))) || {};
            } catch (e: any) {
              bridge.log(`tree.getTreeItem(${viewId}) failed: ${e?.message || e}`);
            }
            const nodeId = `tree-${_nextTreeNodeId++}`;
            _treeItems.set(nodeId, { provider: inst, element: el, item: treeItem });
            return {
              nodeId,
              label: typeof treeItem.label === 'string' ? treeItem.label : (treeItem.label?.label ?? String(el)),
              description: typeof treeItem.description === 'string' ? treeItem.description : undefined,
              tooltip: typeof treeItem.tooltip === 'string' ? treeItem.tooltip : (treeItem.tooltip?.value),
              collapsibleState: treeItem.collapsibleState ?? 0,
              iconPath: treeItem.iconPath?.id ?? (typeof treeItem.iconPath === 'string' ? treeItem.iconPath : undefined),
              contextValue: treeItem.contextValue,
              command: treeItem.command ? {
                command: treeItem.command.command,
                title: treeItem.command.title,
                arguments: treeItem.command.arguments,
              } : undefined,
              resourceUri: treeItem.resourceUri?.toString?.(),
            };
          }));
          bridge.send({
            jsonrpc: '2.0', method: 'tree/childrenResponse',
            params: { requestId, items },
          });
        })();
        break;
      }
      // Tree node click → run any command attached to the item, OR fire
      // the provider's onDidChangeSelection if it's wired.
      case 'tree/nodeClicked': {
        const node = _treeItems.get(params?.nodeId);
        if (!node) break;
        const cmd = node.item?.command;
        if (cmd?.command) {
          // Dispatch through our local command registry (or bridge to
          // the workbench if it's a built-in).
          if (commandRegistry.has(cmd.command)) {
            try { commandRegistry.get(cmd.command)!(...(cmd.arguments || [])); } catch { /* ignore */ }
          } else {
            rpcRequest('commands/execute', { command: cmd.command, args: cmd.arguments || [] }).catch(() => {});
          }
        }
        break;
      }
      // ── Phase C: webview view (sidebar) lifecycle hooks ────────────
      // The bridge tells us a sidebar webview has opened or been
      // resolved; we call the extension's resolveWebviewView so it can
      // inject html / hook events.
      case 'webviewView/resolve': {
        const inst = _webviewViews.get(params?.viewId);
        if (!inst) break;
        const onDidReceiveMessageEvent = new VSCodeEvent<any>('webviewView/messageFromWebview');
        const onDidDisposeEvent = new VSCodeEvent<void>('webviewView/didDispose');
        // Register the emitters so messageFromWebview can route messages
        // back to the extension's onDidReceiveMessage handler.
        _webviewViewMessageEmitters.set(params?.viewId, onDidReceiveMessageEvent);
        _webviewViewDisposeEmitters.set(params?.viewId, onDidDisposeEvent);
        const view = {
          viewType: params?.viewId,
          webview: {
            html: '',
            options: inst.options?.webviewOptions || {},
            // CSP source the extension HTML can use as a placeholder
            // in <meta http-equiv="Content-Security-Policy">. Matches
            // the scheme our protocol handler serves.
            cspSource: WEBVIEW_CSP_SOURCE,
            asWebviewUri(uri: Uri) {
              return Uri.parse(fsPathToWebviewUrl(uri.fsPath));
            },
            postMessage(msg: any) {
              return rpcRequest('webviewView/postMessage', { viewId: params?.viewId, message: msg })
                .then(() => true).catch(() => false);
            },
            onDidReceiveMessage: onDidReceiveMessageEvent.event,
          },
          onDidDispose: onDidDisposeEvent.event,
          onDidChangeVisibility: new VSCodeEvent<void>('webviewView/visibility').event,
          show: () => rpcRequest('webviewView/reveal', { viewId: params?.viewId }).catch(() => {}),
          title: '',
          description: '',
          visible: true,
          badge: undefined,
        };
        // Wire html setter
        Object.defineProperty(view.webview, 'html', {
          get() { return (view as any)._html || ''; },
          set(v: string) {
            (view as any)._html = v;
            rpcRequest('webviewView/setHtml', { viewId: params?.viewId, html: v }).catch(() => {});
          },
        });
        try {
          inst.provider.resolveWebviewView?.(view, { state: undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) });
        } catch (e: any) {
          bridge.log(`webviewView.resolve(${params?.viewId}) failed: ${e?.message || e}`);
        }
        break;
      }
      case 'webviewView/messageFromWebview': {
        const emitter = _webviewViewMessageEmitters.get(params?.viewId);
        if (emitter) emitter.fire(params?.message);
        break;
      }
      case 'webviewView/didDispose': {
        const dispEmitter = _webviewViewDisposeEmitters.get(params?.viewId);
        if (dispEmitter) dispEmitter.fire(undefined);
        _webviewViewMessageEmitters.delete(params?.viewId);
        _webviewViewDisposeEmitters.delete(params?.viewId);
        break;
      }

      // ── Phase B: chat participant dispatch ────────────────────────
      // OPIDE's chat panel sends this when the user types `@<id> ...`.
      // We look up the participant and call its handler with a
      // ChatResponseStream that streams chunks back via
      // 'chat/streamChunk' notifications keyed on the same requestId.
      case 'chat/dispatch': {
        const part = _chatParticipants.get(params?.participantId);
        if (!part) {
          bridge.send({
            jsonrpc: '2.0',
            method: 'chat/dispatchEnd',
            params: { requestId: params?.requestId, error: 'participant not found' },
          });
          break;
        }
        const requestId: string = params?.requestId;
        // Build the ChatResponseStream that the participant calls into.
        // Each method translates to a streamChunk notification with a
        // tagged kind so the UI can render text/anchors/buttons/etc
        // correctly. Returns a disposable-shaped object since some
        // extensions chain calls.
        const stream = {
          markdown(value: any) {
            const text = typeof value === 'string' ? value : (value?.value ?? '');
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: { requestId, kind: 'markdown', value: text },
            });
            return stream;
          },
          anchor(value: any, title?: string) {
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: {
                requestId, kind: 'anchor',
                value: typeof value === 'string' ? value : value?.toString?.() ?? '',
                title,
              },
            });
            return stream;
          },
          button(command: any) {
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: { requestId, kind: 'button', command },
            });
            return stream;
          },
          filetree(value: any, baseUri: any) {
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: { requestId, kind: 'filetree', value, baseUri: baseUri?.toString?.() },
            });
            return stream;
          },
          progress(message: string) {
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: { requestId, kind: 'progress', message },
            });
            return stream;
          },
          reference(value: any) {
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: { requestId, kind: 'reference', value: value?.toString?.() ?? value },
            });
            return stream;
          },
          push(part: any) {
            // Unknown part: forward as-is so the UI can decide.
            bridge.send({
              jsonrpc: '2.0', method: 'chat/streamChunk',
              params: { requestId, kind: 'raw', value: part },
            });
            return stream;
          },
        };
        const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
        const request = {
          prompt: params?.prompt ?? '',
          command: params?.command,
          references: params?.references ?? [],
          participant: params?.participantId,
          location: params?.location ?? 1,
        };
        const context = { history: params?.history ?? [] };
        Promise.resolve()
          .then(() => part.handler(request, context, stream, cancellation))
          .then((result: any) => {
            bridge.send({
              jsonrpc: '2.0', method: 'chat/dispatchEnd',
              params: { requestId, result },
            });
          })
          .catch((err: any) => {
            bridge.log(`chat handler error for ${params?.participantId}: ${err?.message || err}`);
            bridge.send({
              jsonrpc: '2.0', method: 'chat/dispatchEnd',
              params: { requestId, error: String(err?.message || err) },
            });
          });
        break;
      }

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
    // Phase C: tree + theming helpers
    TreeItemCollapsibleState,
    ThemeIcon,
    ThemeColor,
    EventEmitter: VSCodeEventEmitter,
    // Phase D: debug
    DebugAdapterExecutable,
    DebugAdapterServer,
    DebugAdapterNamedPipeServer,
    DebugAdapterInlineImplementation,
    DebugConsoleMode,
    SourceBreakpoint,
    FunctionBreakpoint,
    // Phase H: notebook value classes accessed at activation time
    NotebookCellOutputItem,
    NotebookCellOutput,
    // Coding-agent surface: classes/enums extensions touch on activation
    Disposable: VsCodeDisposable,
    FileType,
    FileChangeType,
    FileSystemError,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    TabInputWebview,
    TabInputNotebook,
    TabInputNotebookDiff,
    TabInputTerminal,
    LogLevel,
    MarkdownString,
    Hover,
    CodeAction,
    CodeActionKind,
    SnippetString,
    WorkspaceEdit,
    SymbolKind,
    SymbolInformation,
    DocumentSymbol,

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
      // Coding-agent additions:
      onWillSaveTextDocument: new VSCodeEvent<any>('onWillSaveTextDocument').event,
      onDidChangeWorkspaceFolders: new VSCodeEvent<any>('onDidChangeWorkspaceFolders').event,
      onDidCreateFiles: new VSCodeEvent<any>('onDidCreateFiles').event,
      onDidDeleteFiles: new VSCodeEvent<any>('onDidDeleteFiles').event,
      onDidRenameFiles: new VSCodeEvent<any>('onDidRenameFiles').event,
      get textDocuments() { return [...openDocuments.values()]; },
      asRelativePath(pathOrUri: any, includeWorkspaceFolder?: boolean): string {
        const p = typeof pathOrUri === 'string' ? pathOrUri : (pathOrUri?.fsPath ?? String(pathOrUri ?? ''));
        if (!workspacePath) return p;
        if (p.startsWith(workspacePath)) {
          const rel = p.slice(workspacePath.length).replace(/^[/\\]+/, '');
          if (includeWorkspaceFolder && workspacePath) {
            return `${path.basename(workspacePath)}/${rel}`;
          }
          return rel;
        }
        return p;
      },
      registerFileSystemProvider(_scheme: string, _provider: any, _options?: any) {
        // Real fs-provider routing is a deeper integration. For now,
        // accept the registration so extensions don't crash; the
        // workbench's URI resolver will fall through to disk for
        // file:// URIs which covers the 99% case for coding agents.
        bridge.log(`workspace.registerFileSystemProvider stub for scheme: ${_scheme}`);
        return new VsCodeDisposable();
      },
      registerTextDocumentContentProvider(_scheme: string, _provider: any) {
        // VS Code lets extensions back custom URIs (output:, untitled:,
        // etc) via providers. We don't yet route reads through them;
        // accept the registration so activation doesn't crash.
        bridge.log(`workspace.registerTextDocumentContentProvider stub for scheme: ${_scheme}`);
        return new VsCodeDisposable();
      },
      applyEdit(_edit: WorkspaceEdit): Promise<boolean> {
        // Forward to the bridge once we wire WorkspaceEdit application.
        // Returning false means "edit didn't apply" — extensions handle this.
        return Promise.resolve(false);
      },
      saveAll(): Promise<boolean> {
        return rpcRequest('workspace/saveAll', {}).then(() => true).catch(() => false);
      },
      get name(): string | undefined { return workspacePath ? path.basename(workspacePath) : undefined; },
      // rootPath is already declared as a data property above; we don't
      // re-declare as accessor here.
      isTrusted: true,

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
      // Coding-agent additions:
      onDidChangeTextEditorSelection: new VSCodeEvent<any>('onDidChangeTextEditorSelection').event,
      onDidChangeVisibleTextEditors: new VSCodeEvent<any>('onDidChangeVisibleTextEditors').event,
      onDidChangeTextEditorVisibleRanges: new VSCodeEvent<any>('onDidChangeTextEditorVisibleRanges').event,
      onDidChangeWindowState: new VSCodeEvent<any>('onDidChangeWindowState').event,
      get visibleTextEditors() { return _activeTextEditor ? [_activeTextEditor] : []; },
      get state() { return { focused: true, active: true }; },
      registerUriHandler(_handler: any) {
        // Used for OAuth callbacks (e.g. Continue/Cody sign-in returns).
        // Real handler routing comes with auth v2; accept the
        // registration so activation completes.
        return new VsCodeDisposable();
      },
      registerWebviewPanelSerializer(_viewType: string, _serializer: any) {
        // Used by extensions that want to restore webview panels
        // across IDE restarts. Accept the registration; serializer is
        // never invoked because we don't persist webview state yet.
        return new VsCodeDisposable();
      },
      tabGroups: {
        all: [] as any[],
        activeTabGroup: undefined as any,
        onDidChangeTabs: new VSCodeEvent<any>('onDidChangeTabs').event,
        onDidChangeTabGroups: new VSCodeEvent<any>('onDidChangeTabGroups').event,
        async close(_tabOrTabs: any, _preserveFocus?: boolean): Promise<boolean> {
          return true;
        },
      },

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

      // VS Code's createOutputChannel has two shapes:
      //   createOutputChannel(name)                        → OutputChannel
      //   createOutputChannel(name, { log: true })         → LogOutputChannel
      //   createOutputChannel(name, languageId)            → LanguageOutputChannel
      // Claude Code, Continue, and most coding agents pass `{ log: true }`
      // and then call .info() / .warn() / .error() / .trace() / .debug().
      // Without the LogOutputChannel branch their activate() throws
      // immediately when they try to log anything, before they can
      // register UI. We detect the options arg and return the right
      // shape; all flavours share the underlying lines buffer.
      createOutputChannel(name: string, optionsOrLanguageId?: any) {
        const lines: string[] = [];
        outputChannels.set(name, lines);
        const isLog = !!(optionsOrLanguageId && typeof optionsOrLanguageId === 'object' && optionsOrLanguageId.log === true);

        const base = {
          name,
          append(value: string) {
            lines.push(value);
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
          replace(value: string) {
            lines.length = 0;
            lines.push(value);
            rpcRequest('window/showOutputChannel', {
              name, content: value, append: false, show: false,
            }).catch(() => {});
          },
          show() {
            rpcRequest('window/showOutputChannel', {
              name, content: lines.join(''), append: false, show: true,
            }).catch(() => {});
          },
          hide() {},
          dispose() { outputChannels.delete(name); },
        };

        if (!isLog) return base;

        // LogOutputChannel: levelled logging methods. Each fans out to
        // appendLine with a [LEVEL] prefix so the rendered text shows
        // the level. Format args through util-style sprintf-lite: %s
        // gets stringified, %j JSON-stringified, others coerced.
        function fmt(template: string, ...args: any[]): string {
          if (args.length === 0) return template;
          let i = 0;
          return template.replace(/%[sdjifoO%]/g, (m) => {
            if (m === '%%') return '%';
            const v = args[i++];
            if (m === '%s') return String(v);
            if (m === '%d' || m === '%i') return String(Number(v));
            if (m === '%f') return String(parseFloat(v));
            if (m === '%j' || m === '%o' || m === '%O') {
              try { return JSON.stringify(v); } catch { return String(v); }
            }
            return String(v);
          });
        }
        function logAt(level: string, msg: any, ...args: any[]): void {
          // Accept Error objects (most agents pass `err` directly).
          let text: string;
          if (msg instanceof Error) text = `${msg.message}\n${msg.stack ?? ''}`;
          else if (typeof msg === 'string') text = fmt(msg, ...args);
          else text = String(msg);
          base.appendLine(`[${level}] ${text}${args.length && typeof msg !== 'string' ? ' ' + args.map(String).join(' ') : ''}`);
        }
        return Object.assign(base, {
          logLevel: 3, // LogLevel.Info
          onDidChangeLogLevel: new VSCodeEvent<any>('onDidChangeLogLevel').event,
          trace: (msg: any, ...args: any[]) => logAt('TRACE', msg, ...args),
          debug: (msg: any, ...args: any[]) => logAt('DEBUG', msg, ...args),
          info: (msg: any, ...args: any[]) => logAt('INFO', msg, ...args),
          warn: (msg: any, ...args: any[]) => logAt('WARN', msg, ...args),
          error: (msg: any, ...args: any[]) => logAt('ERROR', msg, ...args),
        });
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
          // Per-extension identity (not the global extensions root).
          // Lets the workbench webview scope localResourceRoots to
          // just this extension's install dir.
          extensionId: _currentExtensionId,
          extensionPath: _currentExtensionPath,
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
          // load. We have a custom Tauri-registered `opide-ext://`
          // protocol that serves files from ~/.opide/extensions/<id>/.
          asWebviewUri(uri: Uri) {
            return Uri.parse(fsPathToWebviewUrl(uri.fsPath));
          },
          cspSource: WEBVIEW_CSP_SOURCE,
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

      // Phase C.C1: Tree data providers. The view id must match a
      // contributes.views entry from package.json so OPIDE can host
      // the tree in the right sidebar slot. We register the provider
      // and fire a refresh event whenever the extension calls
      // emitter.fire(); the bridge re-fetches children from the root.
      registerTreeDataProvider(viewId: string, provider: any) {
        const inst: TreeProviderInst = { viewId, provider };
        _treeProviders.set(viewId, inst);
        rpcRequest('tree/registerProvider', { viewId }).catch(() => {});
        if (provider.onDidChangeTreeData?.event ?? provider.onDidChangeTreeData) {
          const eventEmitter: any = provider.onDidChangeTreeData?.event
            ? provider.onDidChangeTreeData
            : provider.onDidChangeTreeData;
          // VS Code's TreeDataProvider exposes onDidChangeTreeData as a
          // function; calling it with a listener subscribes. We forward
          // changes by signalling the bridge to refresh from root.
          if (typeof eventEmitter === 'function') {
            inst.onChangeListener = eventEmitter((_e: any) => {
              rpcRequest('tree/refresh', { viewId }).catch(() => {});
            });
          }
        }
        return {
          dispose: () => {
            _treeProviders.delete(viewId);
            // Also drop any cached items belonging to this provider so
            // they don't leak across re-registrations.
            for (const [nid, rec] of _treeItems) {
              if (rec.provider === inst) _treeItems.delete(nid);
            }
            rpcRequest('tree/disposeProvider', { viewId }).catch(() => {});
          },
        };
      },

      // Phase C.C2: Sidebar webview views. Same iframe infrastructure
      // as createWebviewPanel (Phase A.A1) but mounted in a sidebar
      // slot keyed by viewId. The bridge calls webviewView/resolve
      // when the user reveals the view; the extension fills it in.
      registerWebviewViewProvider(viewId: string, provider: any, options?: any) {
        _webviewViews.set(viewId, { viewId, provider, options });
        // Attach current extension's identity so the workbench webview
        // can scope localResourceRoots correctly. Without this, the
        // webview can't load <script src="opide-ext://..."> from the
        // extension's install dir.
        rpcRequest('webviewView/registerProvider', {
          viewId,
          options: options || {},
          extensionId: _currentExtensionId,
          extensionPath: _currentExtensionPath,
        }).catch(() => {});
        return {
          dispose: () => {
            _webviewViews.delete(viewId);
            rpcRequest('webviewView/disposeProvider', { viewId }).catch(() => {});
          },
        };
      },

      // VS Code also exposes createTreeView as a more advanced wrapper.
      // For v1 this is a thin shim around registerTreeDataProvider that
      // returns a TreeView-like object (refresh, reveal stubs).
      createTreeView(viewId: string, options: any) {
        const provider = options?.treeDataProvider;
        const sub = provider ? this.registerTreeDataProvider(viewId, provider) : { dispose: () => {} };
        return {
          visible: true,
          selection: [] as any[],
          onDidChangeSelection: new VSCodeEvent<any>('onDidChangeSelection').event,
          onDidChangeVisibility: new VSCodeEvent<any>('onDidChangeVisibility').event,
          onDidExpandElement: new VSCodeEvent<any>('onDidExpandElement').event,
          onDidCollapseElement: new VSCodeEvent<any>('onDidCollapseElement').event,
          reveal: async () => { rpcRequest('tree/reveal', { viewId }).catch(() => {}); },
          dispose: () => sub.dispose(),
        };
      },

      // ── Phase I: custom editors ──────────────────────────────────
      registerCustomEditorProvider(viewType: string, provider: any, options?: any) {
        rpcRequest('customEditor/registerProvider', { viewType, options: options || {} }).catch(() => {});
        // We track a minimal in-shim record so resolveCustomEditor can
        // route incoming open requests; the bridge mounts the iframe
        // panel and round-trips fileToWebviewMessage / webviewToFile.
        const inst = { viewType, provider };
        _customEditorProviders.set(viewType, inst);
        return { dispose() { _customEditorProviders.delete(viewType); rpcRequest('customEditor/disposeProvider', { viewType }).catch(() => {}); } };
      },
      registerFileDecorationProvider(provider: any) {
        // File decorations (badges in the file explorer). Phase I v1
        // just acknowledges; rendering is wired in extension-decorations
        // as a follow-up.
        rpcRequest('fileDecorations/registerProvider', {}).catch(() => {});
        void provider;
        return { dispose: () => {} };
      },

      // ── Phase E.E2: terminal ─────────────────────────────────────
      onDidOpenTerminal: onDidOpenTerminal.event,
      onDidCloseTerminal: onDidCloseTerminal.event,
      get terminals() { return [..._terminals.values()]; },
      get activeTerminal() {
        const arr = [..._terminals.values()];
        return arr.length > 0 ? arr[arr.length - 1] : undefined;
      },
      createTerminal(nameOrOptions: any, shellPath?: string, shellArgs?: string[]) {
        const opts = typeof nameOrOptions === 'string'
          ? { name: nameOrOptions, shellPath, shellArgs }
          : (nameOrOptions || {});
        const tid = `term-${_nextTerminalId++}`;
        const term: any = {
          name: opts.name || 'extension',
          processId: Promise.resolve(undefined),
          creationOptions: opts,
          exitStatus: undefined,
          state: { isInteractedWith: false },
          shellIntegration: undefined,
          sendText(text: string, addNewLine = true) {
            rpcRequest('terminal/sendText', { id: tid, text, addNewLine }).catch(() => {});
          },
          show(preserveFocus?: boolean) {
            rpcRequest('terminal/show', { id: tid, preserveFocus }).catch(() => {});
          },
          hide() { rpcRequest('terminal/hide', { id: tid }).catch(() => {}); },
          dispose() {
            _terminals.delete(tid);
            rpcRequest('terminal/dispose', { id: tid }).catch(() => {});
            onDidCloseTerminal.fire(term);
          },
        };
        _terminals.set(tid, term);
        rpcRequest('terminal/create', {
          id: tid, name: term.name, cwd: opts.cwd,
          shellPath: opts.shellPath, shellArgs: opts.shellArgs, env: opts.env,
        }).catch(() => {});
        onDidOpenTerminal.fire(term);
        return term;
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

      // P1: vscode.languages.registerInlineCompletionItemProvider —
      // the API Copilot, Tabnine, Codeium, Continue, Cody-completions,
      // and friends all use to deliver ghost-text suggestions as the
      // user types. We register the provider locally AND tell the
      // bridge to wire a Monaco inline-completion provider; when the
      // user pauses typing, Monaco calls back through the bridge to
      // 'languages/provideInlineCompletionItems', which we route to
      // the stored provider.
      registerInlineCompletionItemProvider(selector: any, provider: any) {
        const id = `icp-${_nextInlineCompletionId++}`;
        const langs = selectorToLanguageIds(selector);
        _inlineCompletionProviders.set(id, { provider, languages: langs, selector });
        rpcRequest('languages/registerInlineCompletionProvider', {
          providerId: id,
          languages: langs,
          selector,
        }).catch(() => {});
        return {
          dispose() {
            _inlineCompletionProviders.delete(id);
            rpcRequest('languages/disposeInlineCompletionProvider', { providerId: id }).catch(() => {});
          },
        };
      },

      match(selector: any, document: any): number {
        return 1; // Simplified — always match
      },

      getDiagnostics(resource?: Uri): any[] {
        // Return all diagnostics across collections, or scoped to a uri.
        const out: any[] = [];
        for (const diags of diagnosticCollections.values()) {
          for (const [uriPath, items] of diags) {
            if (resource && resource.fsPath !== uriPath) continue;
            out.push(...items);
          }
        }
        return out;
      },
      onDidChangeDiagnostics: new VSCodeEvent<any>('onDidChangeDiagnostics').event,
    },

    // ── extensions ─────────────────────────────────────────────────────
    // Populated lazily by bootstrap.ts after the scan via
    // _setExtensionRegistry. Until then both .all and getExtension
    // return their defaults; that window is short (single tick from
    // module load to scan) but extensions that read this synchronously
    // during activate() rely on it being populated.
    extensions: {
      get all(): any[] {
        return [..._extensionRegistry.values()].map(toPublicExtension);
      },
      getExtension(id: string): any | undefined {
        const rec = lookupExtensionRec(id);
        return rec ? toPublicExtension(rec) : undefined;
      },
      onDidChange: new VSCodeEvent<void>('onDidChange').event,
    },

    // ── version / l10n (top-level scalars expected by activation) ─────
    // Many extensions branch on vscode.version. Reporting the engine
    // we claim to be compatible with avoids "your VS Code is too old"
    // bail-outs at activation time.
    version: '1.97.0',
    l10n: {
      t(message: string, ...args: any[]): string {
        // No catalog — return the source string with positional %0%, %1%
        // substitution. Same fallback behaviour the official l10n
        // module uses when no localization is loaded.
        if (args.length === 0) return message;
        return message.replace(/\{(\d+)\}/g, (_m, i) => String(args[i] ?? ''));
      },
      bundle: undefined,
      uri: undefined,
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

    // ── Phase D: debug ──────────────────────────────────────────────────
    debug: {
      get activeDebugSession() { return _activeDebugSession; },
      get activeDebugConsole() {
        return {
          append(value: string) {
            rpcRequest('debug/consoleAppend', { value, line: false }).catch(() => {});
          },
          appendLine(value: string) {
            rpcRequest('debug/consoleAppend', { value, line: true }).catch(() => {});
          },
        };
      },
      get breakpoints() { return _breakpoints; },
      onDidStartDebugSession: onDidStartDebugSession.event,
      onDidTerminateDebugSession: onDidTerminateDebugSession.event,
      onDidChangeActiveDebugSession: onDidChangeActiveDebugSession.event,
      onDidChangeBreakpoints: onDidChangeBreakpoints.event,
      onDidReceiveDebugSessionCustomEvent: onDidReceiveDebugSessionCustomEvent.event,
      registerDebugAdapterDescriptorFactory(type: string, factory: any) {
        _debugAdapterFactories.set(type, { type, factory });
        rpcRequest('debug/registerAdapterFactory', { type }).catch(() => {});
        return { dispose: () => { _debugAdapterFactories.delete(type); } };
      },
      registerDebugConfigurationProvider(type: string, provider: any, triggerKind?: number) {
        const list = _debugConfigProviders.get(type) || [];
        list.push({ type, provider, trigger: triggerKind });
        _debugConfigProviders.set(type, list);
        return { dispose: () => {
          const arr = _debugConfigProviders.get(type) || [];
          _debugConfigProviders.set(type, arr.filter((p) => p.provider !== provider));
        } };
      },
      async startDebugging(_folder: any, nameOrConfig: any): Promise<boolean> {
        // Resolve config: if a string, look up in launch.json; if an object, use directly.
        const config = typeof nameOrConfig === 'string'
          ? await rpcRequest('debug/resolveLaunchConfig', { name: nameOrConfig }).catch(() => null)
          : nameOrConfig;
        if (!config?.type) return false;
        // Walk through registered providers' resolveDebugConfiguration hooks.
        let resolved = config;
        const providers = _debugConfigProviders.get(config.type) || [];
        for (const p of providers) {
          if (p.provider?.resolveDebugConfiguration) {
            try {
              const r = await Promise.resolve(p.provider.resolveDebugConfiguration(_folder, resolved));
              if (r) resolved = r;
            } catch { /* ignore */ }
          }
        }
        // Resolve adapter descriptor via factory if present.
        let descriptor: any = null;
        const factory = _debugAdapterFactories.get(resolved.type);
        if (factory?.factory?.createDebugAdapterDescriptor) {
          try {
            descriptor = await Promise.resolve(factory.factory.createDebugAdapterDescriptor({ id: 'transient', type: resolved.type, name: resolved.name, configuration: resolved }, undefined));
          } catch (e: any) {
            bridge.log(`debug.createDebugAdapterDescriptor(${resolved.type}) failed: ${e?.message || e}`);
          }
        }
        // Forward to the bridge which spawns via dap.rs and creates the
        // session record.
        const result = await rpcRequest('debug/startSession', {
          config: resolved,
          descriptor: descriptor ? {
            kind: descriptor instanceof DebugAdapterServer ? 'server'
                 : descriptor instanceof DebugAdapterNamedPipeServer ? 'pipe'
                 : descriptor instanceof DebugAdapterInlineImplementation ? 'inline'
                 : 'executable',
            command: descriptor?.command,
            args: descriptor?.args,
            options: descriptor?.options,
            port: descriptor?.port,
            host: descriptor?.host,
            path: descriptor?.path,
          } : null,
        }).catch(() => null);
        if (result?.sessionId) {
          const session: any = {
            id: result.sessionId,
            type: resolved.type,
            name: resolved.name || resolved.type,
            workspaceFolder: _folder,
            configuration: resolved,
            customRequest: (cmd: string, args?: any) =>
              rpcRequest('debug/customRequest', { sessionId: result.sessionId, command: cmd, args })
                .catch(() => null),
            getDebugProtocolBreakpoint: () => Promise.resolve(undefined),
          };
          _activeDebugSessions.set(result.sessionId, session);
          _activeDebugSession = session;
          onDidStartDebugSession.fire(session);
          onDidChangeActiveDebugSession.fire(session);
          return true;
        }
        return false;
      },
      async stopDebugging(session?: any): Promise<void> {
        const id = session?.id ?? _activeDebugSession?.id;
        if (!id) return;
        await rpcRequest('debug/stopSession', { sessionId: id }).catch(() => {});
        const s = _activeDebugSessions.get(id);
        if (s) {
          _activeDebugSessions.delete(id);
          onDidTerminateDebugSession.fire(s);
          if (_activeDebugSession?.id === id) {
            _activeDebugSession = _activeDebugSessions.size > 0 ? _activeDebugSessions.values().next().value : undefined;
            onDidChangeActiveDebugSession.fire(_activeDebugSession);
          }
        }
      },
      addBreakpoints(breakpoints: any[]) {
        _breakpoints.push(...breakpoints);
        rpcRequest('debug/addBreakpoints', { breakpoints: serializeBreakpoints(breakpoints) }).catch(() => {});
        onDidChangeBreakpoints.fire({ added: breakpoints, removed: [], changed: [] });
      },
      removeBreakpoints(breakpoints: any[]) {
        for (const bp of breakpoints) {
          const i = _breakpoints.indexOf(bp);
          if (i >= 0) _breakpoints.splice(i, 1);
        }
        rpcRequest('debug/removeBreakpoints', { breakpoints: serializeBreakpoints(breakpoints) }).catch(() => {});
        onDidChangeBreakpoints.fire({ added: [], removed: breakpoints, changed: [] });
      },
      asDebugSourceUri(source: any) {
        return Uri.parse(`debug:${source?.path || source}`);
      },
    },

    // ── Phase E.E1: tasks ───────────────────────────────────────────────
    tasks: {
      registerTaskProvider(type: string, provider: any) {
        _taskProviders.set(type, { type, provider });
        rpcRequest('tasks/registerProvider', { type }).catch(() => {});
        return { dispose: () => { _taskProviders.delete(type); } };
      },
      async fetchTasks(filter?: any): Promise<any[]> {
        const all: any[] = [];
        for (const inst of _taskProviders.values()) {
          if (filter?.type && inst.type !== filter.type) continue;
          try {
            const t = await Promise.resolve(inst.provider.provideTasks?.({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }));
            if (Array.isArray(t)) all.push(...t);
          } catch { /* ignore */ }
        }
        return all;
      },
      async executeTask(task: any): Promise<any> {
        const result = await rpcRequest('tasks/execute', {
          name: task?.name,
          source: task?.source,
          definition: task?.definition,
          execution: task?.execution ? {
            command: task.execution.commandLine || task.execution.command,
            args: task.execution.args,
            cwd: task.execution.options?.cwd,
            env: task.execution.options?.env,
          } : null,
        }).catch(() => null);
        const exec = {
          task,
          terminate: () => {
            if (result?.executionId) rpcRequest('tasks/terminate', { executionId: result.executionId }).catch(() => {});
          },
        };
        onDidStartTask.fire({ execution: exec });
        return exec;
      },
      taskExecutions: [] as any[],
      onDidStartTask: onDidStartTask.event,
      onDidEndTask: onDidEndTask.event,
      onDidStartTaskProcess: new VSCodeEvent<any>('onDidStartTaskProcess').event,
      onDidEndTaskProcess: new VSCodeEvent<any>('onDidEndTaskProcess').event,
    },

    // ── Phase F: scm ────────────────────────────────────────────────────
    scm: {
      createSourceControl(id: string, label: string, rootUri?: any) {
        const inst: SourceControlInst = {
          id, label, rootUri,
          resourceGroups: new Map(),
          inputBox: {
            value: '',
            placeholder: '',
            visible: true,
          },
          count: 0,
        };
        _sourceControls.set(id, inst);
        rpcRequest('scm/createSourceControl', { id, label, rootUri: rootUri?.toString?.() }).catch(() => {});
        return {
          id, label, rootUri,
          get inputBox() { return inst.inputBox; },
          set count(v: number) { inst.count = v; rpcRequest('scm/setCount', { id, count: v }).catch(() => {}); },
          set quickDiffProvider(v: any) { inst.quickDiffProvider = v; },
          set statusBarCommands(v: any[]) { inst.statusBarCommands = v; rpcRequest('scm/setStatusBar', { id, commands: v }).catch(() => {}); },
          createResourceGroup(groupId: string, groupLabel: string) {
            const groupKey = `${id}:${groupId}:${_nextScmGroupId++}`;
            const group = {
              id: groupId, label: groupLabel, hideWhenEmpty: false,
              resourceStates: [] as any[],
              dispose() {
                inst.resourceGroups.delete(groupKey);
                rpcRequest('scm/disposeGroup', { groupKey }).catch(() => {});
              },
            };
            inst.resourceGroups.set(groupKey, group);
            rpcRequest('scm/createGroup', { id, groupId, groupLabel, groupKey }).catch(() => {});
            // Define a setter via Object.defineProperty so assigning
            // resourceStates pushes to the bridge.
            Object.defineProperty(group, 'resourceStates', {
              get() { return (this as any)._states || []; },
              set(v: any[]) {
                (this as any)._states = v;
                rpcRequest('scm/setResourceStates', {
                  groupKey,
                  resources: (v || []).map((s: any) => ({
                    resourceUri: s?.resourceUri?.toString?.(),
                    decorations: s?.decorations,
                    contextValue: s?.contextValue,
                    command: s?.command,
                  })),
                }).catch(() => {});
              },
            });
            return group;
          },
          dispose() {
            _sourceControls.delete(id);
            rpcRequest('scm/disposeSourceControl', { id }).catch(() => {});
          },
        };
      },
    },

    // ── Phase G: tests ──────────────────────────────────────────────────
    tests: {
      createTestController(id: string, label: string) {
        const inst: TestControllerInst = {
          id, label,
          items: new Map(),
          runProfiles: new Map(),
        };
        _testControllers.set(id, inst);
        rpcRequest('tests/createController', { id, label }).catch(() => {});
        const controller = {
          id, label,
          items: {
            add: (item: any) => { inst.items.set(item.id, item); rpcRequest('tests/addItem', { controllerId: id, item: serializeTestItem(item) }).catch(() => {}); },
            delete: (itemId: string) => { inst.items.delete(itemId); rpcRequest('tests/removeItem', { controllerId: id, itemId }).catch(() => {}); },
            replace: (items: any[]) => {
              inst.items.clear();
              for (const it of items) inst.items.set(it.id, it);
              rpcRequest('tests/replaceItems', { controllerId: id, items: items.map(serializeTestItem) }).catch(() => {});
            },
            get: (itemId: string) => inst.items.get(itemId),
            forEach: (cb: (it: any) => void) => { inst.items.forEach(cb); },
            size: inst.items.size,
            [Symbol.iterator]: () => inst.items.values(),
          },
          createTestItem(itemId: string, itemLabel: string, uri?: any) {
            const item: any = {
              id: itemId, label: itemLabel, uri,
              children: { add: () => {}, delete: () => {}, replace: () => {}, get: () => undefined, forEach: () => {}, size: 0 },
              parent: undefined,
              tags: [],
              canResolveChildren: false,
              busy: false,
              description: undefined,
              error: undefined,
              range: undefined,
              sortText: undefined,
            };
            return item;
          },
          createRunProfile(profileLabel: string, kind: number, runHandler: any, isDefault?: boolean) {
            const profileId = `prof-${_nextTestProfileId++}`;
            const profile: any = { label: profileLabel, kind, runHandler, isDefault, profileId,
              configureHandler: undefined, tag: undefined, supportsContinuousRun: false,
              dispose() { inst.runProfiles.delete(profileId); rpcRequest('tests/disposeRunProfile', { controllerId: id, profileId }).catch(() => {}); },
            };
            inst.runProfiles.set(profileId, profile);
            rpcRequest('tests/createRunProfile', { controllerId: id, profileId, label: profileLabel, kind, isDefault }).catch(() => {});
            return profile;
          },
          createTestRun(request: any, name?: string, persist?: boolean) {
            const runId = `run-${_nextTestRunId++}`;
            rpcRequest('tests/startRun', { controllerId: id, runId, name }).catch(() => {});
            return {
              name: name || 'test run',
              isPersisted: !!persist,
              token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
              enqueued: (test: any) => rpcRequest('tests/runState', { runId, testId: test?.id, state: 'enqueued' }).catch(() => {}),
              started: (test: any) => rpcRequest('tests/runState', { runId, testId: test?.id, state: 'started' }).catch(() => {}),
              skipped: (test: any) => rpcRequest('tests/runState', { runId, testId: test?.id, state: 'skipped' }).catch(() => {}),
              passed: (test: any, duration?: number) => rpcRequest('tests/runState', { runId, testId: test?.id, state: 'passed', duration }).catch(() => {}),
              failed: (test: any, message: any, duration?: number) => rpcRequest('tests/runState', { runId, testId: test?.id, state: 'failed', message, duration }).catch(() => {}),
              errored: (test: any, message: any, duration?: number) => rpcRequest('tests/runState', { runId, testId: test?.id, state: 'errored', message, duration }).catch(() => {}),
              appendOutput: (output: string, _location?: any, _test?: any) => rpcRequest('tests/runOutput', { runId, output }).catch(() => {}),
              end: () => rpcRequest('tests/endRun', { runId }).catch(() => {}),
            };
          },
          set refreshHandler(v: any) { inst.refreshHandler = v; },
          set resolveHandler(v: any) { inst.resolveHandler = v; },
          dispose() {
            _testControllers.delete(id);
            rpcRequest('tests/disposeController', { controllerId: id }).catch(() => {});
          },
        };
        return controller;
      },
    },

    // ── Phase H: notebooks ──────────────────────────────────────────────
    notebooks: {
      createNotebookController(id: string, viewType: string, label: string, handler?: any) {
        const inst: NotebookControllerInst = { id, viewType, label, executeHandler: handler };
        _notebookControllers.set(id, inst);
        rpcRequest('notebooks/createController', { id, viewType, label }).catch(() => {});
        const controller: any = {
          id, viewType, label,
          set executeHandler(v: any) { inst.executeHandler = v; },
          set interruptHandler(v: any) { inst.interruptHandler = v; },
          set supportedLanguages(v: string[]) { inst.supportedLanguages = v; rpcRequest('notebooks/updateController', { id, supportedLanguages: v }).catch(() => {}); },
          set supportsExecutionOrder(v: boolean) { inst.supportsExecutionOrder = v; },
          createNotebookCellExecution(cell: any) {
            const start = Date.now();
            return {
              executionOrder: undefined,
              start: (startTime?: number) => rpcRequest('notebooks/cellExecStart', { id, cellIndex: cell?.index, startTime: startTime || start }).catch(() => {}),
              end: (success?: boolean, endTime?: number) => rpcRequest('notebooks/cellExecEnd', { id, cellIndex: cell?.index, success, endTime: endTime || Date.now() }).catch(() => {}),
              clearOutput: () => rpcRequest('notebooks/cellClearOutput', { id, cellIndex: cell?.index }).catch(() => {}),
              replaceOutput: (out: any) => rpcRequest('notebooks/cellReplaceOutput', { id, cellIndex: cell?.index, output: serializeNotebookOutput(out) }).catch(() => {}),
              appendOutput: (out: any) => rpcRequest('notebooks/cellAppendOutput', { id, cellIndex: cell?.index, output: serializeNotebookOutput(out) }).catch(() => {}),
              token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
            };
          },
          dispose() {
            _notebookControllers.delete(id);
            rpcRequest('notebooks/disposeController', { id }).catch(() => {});
          },
        };
        return controller;
      },
      registerNotebookSerializer(notebookType: string, serializer: any) {
        _notebookSerializers.set(notebookType, serializer);
        rpcRequest('notebooks/registerSerializer', { notebookType }).catch(() => {});
        return { dispose: () => { _notebookSerializers.delete(notebookType); } };
      },
    },

    // ── Phase B.B1: chat ────────────────────────────────────────────────
    // Chat participants register themselves here. OPIDE's chat panel
    // surfaces them as `@<id>` mentions; user prompts are dispatched
    // via 'chat/dispatch' which fires the registered handler. Streaming
    // back to the user uses the ChatResponseStream methods (markdown,
    // anchor, button, filetree, progress, reference) — each method
    // sends a 'chat/streamChunk' notification.
    chat: {
      createChatParticipant(id: string, handler: any) {
        const inst: ParticipantInst = { id, handler, options: {} };
        _chatParticipants.set(id, inst);
        rpcRequest('chat/registerParticipant', { id }).catch(() => {});
        const participant = {
          id,
          // Many extensions assign these as properties after creation;
          // we forward updates to the bridge so OPIDE's chat surface
          // can render the avatar/follow-up handlers.
          set iconPath(v: any) { inst.iconPath = v; rpcRequest('chat/updateParticipant', { id, iconPath: v?.toString?.() ?? v }).catch(() => {}); },
          get iconPath() { return inst.iconPath; },
          set followupProvider(v: any) { inst.options.followupProvider = v; },
          set fullName(v: string) { inst.options.fullName = v; rpcRequest('chat/updateParticipant', { id, fullName: v }).catch(() => {}); },
          set commandProvider(v: any) { inst.options.commandProvider = v; },
          dispose() {
            _chatParticipants.delete(id);
            rpcRequest('chat/disposeParticipant', { id }).catch(() => {});
          },
          requestHandler: handler,
        };
        return participant;
      },
      registerChatVariableResolver(name: string, _description: string, resolver: any) {
        // Variable resolvers (#file, #selection, etc) — track but the
        // wiring into OPIDE's chat textarea is incremental.
        rpcRequest('chat/registerVariableResolver', { name }).catch(() => {});
        return { dispose: () => { /* TODO: track */ } };
      },
    },

    // ── Phase B.B2: lm (language model API) ──────────────────────────
    // Routes through OPIDE's provider factory: the extension asks for a
    // model by vendor/family, OPIDE returns a wrapper that calls our
    // own LLM pipeline (Anthropic, OpenAI, Claude Code CLI, etc). The
    // user's API keys never leave OPIDE — extensions get the models
    // through OPIDE's auth, which is the whole point of this design.
    lm: {
      async selectChatModels(selector?: any): Promise<any[]> {
        const models = await rpcRequest('lm/selectModels', { selector: selector || {} })
          .catch(() => []);
        return (models || []).map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          vendor: m.vendor || 'opide',
          family: m.family || m.id,
          version: m.version || '1.0',
          maxInputTokens: m.maxInputTokens || 200_000,
          // Extension calls model.sendRequest(messages, opts, token); we
          // route to lm/sendRequest and stream the response back.
          async sendRequest(messages: any[], options?: any, token?: any): Promise<any> {
            const requestId = `lm-${_nextRequestId++}`;
            const chunks: string[] = [];
            // Simple streaming: collect chunks pushed via lm/streamChunk
            // notification then yield them to the extension as an async
            // iterator over its `text` and `stream` properties.
            const onChunk = (msg: any) => {
              if (msg?.method === 'lm/streamChunk' && msg?.params?.requestId === requestId) {
                chunks.push(msg.params.text || '');
              }
            };
            bridge.onMessage(onChunk);
            try {
              const result = await rpcRequest('lm/sendRequest', {
                requestId,
                modelId: m.id,
                messages: messages.map((mm: any) => ({
                  role: mm.role ?? 'user',
                  content: typeof mm.content === 'string'
                    ? mm.content
                    : (mm.content || []).map((c: any) => c?.text ?? '').join(''),
                })),
                options: options || {},
              });
              // If no streaming chunks were emitted, fall back to the
              // final text the bridge returned. Either way, expose
              // both `text` (async iterable of strings) and `stream`
              // for compatibility with extensions that read either.
              if (chunks.length === 0 && result?.text) chunks.push(result.text);
              const asyncIter = {
                async *[Symbol.asyncIterator]() {
                  for (const c of chunks) yield c;
                },
              };
              return {
                text: (async function* () { for (const c of chunks) yield c; })(),
                stream: asyncIter,
              };
            } finally {
              // CC1 fix: detach the chunk listener so we don't leak
              // handlers across LM calls.
              bridge.offMessage(onChunk);
            }
          },
          async countTokens(text: string): Promise<number> {
            const r = await rpcRequest('lm/countTokens', { modelId: m.id, text })
              .catch(() => ({ count: Math.ceil((text || '').length / 4) }));
            return r?.count ?? Math.ceil((text || '').length / 4);
          },
        }));
      },
      tokens: {
        // Common tokenization helpers extensions sometimes use.
      },
    },

    // ── Phase B.B3: authentication ─────────────────────────────────────
    // OAuth flows happen in the user's default browser via OPIDE's
    // shell openExternal + a localhost loopback the bridge listens on.
    // Sessions are stored in OS keychain so tokens survive restart.
    authentication: {
      async getSession(providerId: string, scopes: string[], options?: any): Promise<any> {
        return rpcRequest('auth/getSession', {
          providerId,
          scopes: scopes || [],
          createIfNone: !!options?.createIfNone,
          forceNewSession: !!options?.forceNewSession,
          clearSessionPreference: !!options?.clearSessionPreference,
        });
      },
      registerAuthenticationProvider(id: string, label: string, provider: any, _options?: any) {
        _authProviders.set(id, { label, provider });
        rpcRequest('auth/registerProvider', { id, label }).catch(() => {});
        return { dispose: () => { _authProviders.delete(id); } };
      },
      onDidChangeSessions: new VSCodeEvent<any>('onDidChangeSessions').event,
    },

    // ── Internal: registry hooks for bootstrap.ts ────────────────────
    /** Bootstrap populates this with every scanned extension's
     * package.json so vscode.extensions.getExtension returns real
     * data instead of undefined. Called once per scan. */
    _setExtensionRegistry(entries: Array<{ id: string; path: string; manifest: any }>) {
      _extensionRegistry.clear();
      for (const e of entries) {
        _extensionRegistry.set(e.id, {
          id: e.id,
          extensionPath: e.path,
          extensionUri: Uri.file(e.path),
          packageJSON: e.manifest,
          isActive: false,
          exports: undefined,
        });
      }
    },
    /** Bootstrap sets this before calling activate(ext), clears after.
     * Lets sync-time api-shim calls inside activate() know which
     * extension is the caller. */
    _setCurrentExtension(id: string | null, path: string | null) {
      _currentExtensionId = id;
      _currentExtensionPath = path;
    },
    /** Bootstrap calls this after activating an extension so
     * getExtension() reflects current state (isActive, exports). */
    _markExtensionActivated(id: string, exports: any) {
      const rec = _extensionRegistry.get(id);
      if (rec) {
        rec.isActive = true;
        rec.exports = exports;
      }
    },

    // ── ExtensionContext (passed to activate) ─────────────────────────
    _createContext(extensionId: string, extPath: string) {
      const storagePath = path.join(workspacePath, '.opide', 'extension-storage', extensionId);
      const globalStoragePath = path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        '.opide', 'extension-global-storage', extensionId
      );
      // Real VS Code populates `context.extension` with the same
      // Extension object that `vscode.extensions.getExtension(id)`
      // returns — Claude Code reads `context.extension.packageJSON.version`
      // during activation, and Continue / Cline do similar. Look up by
      // case-insensitive match because publisher IDs in package.json
      // can differ in case from how extensions self-reference.
      const rec = lookupExtensionRec(extensionId);
      const extensionPublic = rec ? toPublicExtension(rec) : undefined;
      // ExtensionContext.environmentVariableCollection — used by
      // extensions that spawn terminals to inject env vars (Claude Code
      // sets MCP server port + auth token via this so its CLI inherits
      // them). Real VS Code applies these to all terminals the
      // extension creates; we just record them so reads round-trip and
      // get()?.value works. Forwarding to actual terminal env is a TODO
      // for when extension-spawned terminals exist.
      const envMutators = new Map<string, { type: number; value: string; options: any }>();
      const environmentVariableCollection: any = {
        persistent: true,
        description: undefined,
        replace(name: string, value: string, options?: any) {
          envMutators.set(name, { type: 1, value, options: options || {} });
        },
        append(name: string, value: string, options?: any) {
          envMutators.set(name, { type: 2, value, options: options || {} });
        },
        prepend(name: string, value: string, options?: any) {
          envMutators.set(name, { type: 3, value, options: options || {} });
        },
        get(name: string) {
          return envMutators.get(name);
        },
        forEach(cb: (n: string, m: any, c: any) => any) {
          for (const [n, m] of envMutators) cb(n, m, environmentVariableCollection);
        },
        delete(name: string) {
          envMutators.delete(name);
        },
        clear() {
          envMutators.clear();
        },
        // GlobalEnvironmentVariableCollection extension: scoped variant
        // returns a (here: identical) collection for a given scope.
        getScoped(_scope: any) {
          return environmentVariableCollection;
        },
      };
      return {
        subscriptions: disposables,
        extensionPath: extPath,
        extensionUri: Uri.file(extPath),
        extension: extensionPublic,
        environmentVariableCollection,
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

  // ── Helper serializers ─────────────────────────────────────────────
  function serializeBreakpoints(bps: any[]): any[] {
    return (bps || []).map((bp: any) => {
      if (bp instanceof SourceBreakpoint) {
        return {
          kind: 'source',
          uri: bp.location?.uri?.toString?.(),
          line: bp.location?.range?.start?.line ?? 0,
          column: bp.location?.range?.start?.character ?? 0,
          enabled: bp.enabled,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        };
      }
      if (bp instanceof FunctionBreakpoint) {
        return {
          kind: 'function',
          functionName: bp.functionName,
          enabled: bp.enabled,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        };
      }
      return { kind: 'unknown' };
    });
  }
  function serializeTestItem(it: any): any {
    return {
      id: it?.id,
      label: it?.label,
      uri: it?.uri?.toString?.(),
      description: it?.description,
      busy: it?.busy,
      canResolveChildren: it?.canResolveChildren,
      tags: (it?.tags || []).map((t: any) => t?.id ?? String(t)),
      range: it?.range,
    };
  }
  function serializeNotebookOutput(out: any): any {
    if (!out) return out;
    if (Array.isArray(out)) return out.map(serializeNotebookOutput);
    return {
      id: out.id,
      items: (out.items || []).map((item: any) => ({
        mime: item.mime,
        data: typeof item.data === 'string' ? item.data : Buffer.from(item.data || []).toString('base64'),
      })),
      metadata: out.metadata,
    };
  }
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
