// Extension Scanner — finds and parses VS Code extensions in a directory.
// Each extension is a directory with a package.json containing:
//   - name, publisher, version, engines.vscode
//   - main (Node.js entry point) or browser (web entry point)
//   - activationEvents (when to activate)
//   - contributes (commands, languages, themes, etc.)

import * as fs from 'fs';
import * as path from 'path';

/** A view container declaration from contributes.viewsContainers.
 * VS Code groups these by surface ("activitybar", "panel", "secondarySidebar")
 * — we preserve the surface so the workbench can mount them in the
 * matching slot (activity bar gets a clickable icon; panels mount in
 * the bottom panel area; secondarySidebar is the right sidebar). */
export interface ContributedViewContainer {
  surface: 'activitybar' | 'panel' | 'secondarySidebar' | string;
  id: string;
  title: string;
  /** Absolute path to the icon file resolved against the extension dir.
   * Most often an SVG; codicons via "$(name)" syntax also possible. */
  iconPath?: string;
  /** Codicon id when the manifest uses "$(name)" instead of a file path. */
  codiconId?: string;
}

/** A view declaration from contributes.views[containerId].
 * type is one of 'tree' | 'webview' (default 'tree' if missing). */
export interface ContributedView {
  containerId: string;
  id: string;
  name: string;
  type: 'tree' | 'webview';
  /** when-clause expression as a raw string. Evaluated at view-show
   * time against the IContextKeyService — VS Code uses the same
   * syntax (e.g. "claude-code:doesNotSupportSecondarySidebar"). */
  when?: string;
  /** Visibility hint: 'collapsed' or 'hidden' = needs explicit reveal. */
  visibility?: string;
  contextualTitle?: string;
}

export interface ScannedExtension {
  id: string;              // publisher.name
  path: string;            // absolute path to extension dir
  manifest: any;           // parsed package.json
  main?: string;           // Node.js entry point (absolute path)
  browser?: string;        // Web entry point (absolute path)
  activationEvents: string[];
  contributes: {
    commands?: Array<{ command: string; title: string }>;
    languages?: Array<{ id: string; extensions?: string[] }>;
    themes?: Array<{ label: string; uiTheme: string; path: string }>;
    grammars?: Array<{ language: string; scopeName: string; path: string }>;
    [key: string]: any;
  };
  /** Flattened view declarations across every container the extension
   * contributes to. Pre-resolved so the workbench can mount them
   * without re-parsing package.json. */
  contributedViewContainers: ContributedViewContainer[];
  contributedViews: ContributedView[];
}

export function scanExtensions(extensionsDir: string): ScannedExtension[] {
  const extensions: ScannedExtension[] = [];

  if (!fs.existsSync(extensionsDir)) {
    return extensions;
  }

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const extDir = path.join(extensionsDir, entry.name);
    const manifestPath = path.join(extDir, 'package.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);

      // Load NLS dictionary so we can resolve `%foo.bar%` placeholders
      // in user-visible strings (view names, container titles, etc.).
      // Real VS Code picks <locale>.json based on env locale; we always
      // fall back to package.nls.json. Without this, sidebar tabs show
      // "%views.sidebar.name%" literally (Roo, Cline, GitLens all use
      // localized titles).
      const nlsDict: Record<string, string> = {};
      const nlsPath = path.join(extDir, 'package.nls.json');
      if (fs.existsSync(nlsPath)) {
        try {
          const nlsRaw = fs.readFileSync(nlsPath, 'utf-8');
          const parsed = JSON.parse(nlsRaw);
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') nlsDict[k] = v;
            else if (v && typeof v === 'object' && 'message' in (v as any)) {
              nlsDict[k] = String((v as any).message ?? '');
            }
          }
        } catch { /* malformed nls — ignore, fall back to placeholders */ }
      }
      const resolveNls = (s: any): any => {
        if (typeof s !== 'string') return s;
        // VS Code's placeholder syntax: %some.key%
        return s.replace(/%([a-zA-Z0-9_.-]+)%/g, (full, key) =>
          nlsDict[key] !== undefined ? nlsDict[key] : full,
        );
      };

      // Must have name and publisher (or a combined id)
      const publisher = manifest.publisher || 'unknown';
      const name = manifest.name || entry.name;
      const id = `${publisher}.${name}`;

      const ext: ScannedExtension = {
        id,
        path: extDir,
        manifest,
        activationEvents: manifest.activationEvents || ['*'],
        contributes: manifest.contributes || {},
        contributedViewContainers: [],
        contributedViews: [],
      };

      // Resolve entry points
      if (manifest.main) {
        ext.main = path.resolve(extDir, manifest.main);
      }
      if (manifest.browser) {
        ext.browser = path.resolve(extDir, manifest.browser);
      }

      // Flatten contributes.viewsContainers into a single array tagged
      // with the surface (activitybar / panel / secondarySidebar).
      // Resolve icon paths against the extension dir so the workbench
      // can load them without knowing where the extension lives.
      const vcRoot = (manifest.contributes || {}).viewsContainers || {};
      for (const surface of Object.keys(vcRoot)) {
        const entries = vcRoot[surface] || [];
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (!e?.id) continue;
          const iconRaw = typeof e.icon === 'string' ? e.icon : '';
          let iconPath: string | undefined;
          let codiconId: string | undefined;
          if (iconRaw) {
            const m = iconRaw.match(/^\$\(([a-zA-Z0-9-]+)\)$/);
            if (m) codiconId = m[1];
            else iconPath = path.resolve(extDir, iconRaw);
          }
          ext.contributedViewContainers.push({
            surface,
            id: e.id,
            title: resolveNls(e.title) || e.id,
            iconPath,
            codiconId,
          });
        }
      }

      // Flatten contributes.views into a single array tagged with the
      // owning containerId. We accept declarations targeting both the
      // extension's own viewContainers and built-in container ids
      // (e.g. "explorer", "scm", "debug") since extensions like
      // GitLens add views to the built-in SCM panel.
      const viewsRoot = (manifest.contributes || {}).views || {};
      for (const containerId of Object.keys(viewsRoot)) {
        const entries = viewsRoot[containerId] || [];
        if (!Array.isArray(entries)) continue;
        for (const v of entries) {
          if (!v?.id) continue;
          ext.contributedViews.push({
            containerId,
            id: v.id,
            name: resolveNls(v.name) || v.id,
            type: v.type === 'webview' ? 'webview' : 'tree',
            when: v.when,
            visibility: v.visibility,
            contextualTitle: resolveNls(v.contextualTitle),
          });
        }
      }

      extensions.push(ext);
    } catch (e) {
      process.stderr.write(`[ext-host] Failed to parse ${manifestPath}: ${e}\n`);
    }
  }

  return extensions;
}

export function findExtensionForEvent(
  extensions: ScannedExtension[],
  event: string
): ScannedExtension[] {
  return extensions.filter((ext) => {
    return ext.activationEvents.some((ae) => {
      if (ae === '*') return true;
      if (ae === event) return true;
      // Match patterns like "onLanguage:python"
      if (event.startsWith('onLanguage:')) {
        return ae === event;
      }
      // Match "onCommand:extension.command"
      if (event.startsWith('onCommand:')) {
        return ae === event;
      }
      return false;
    });
  });
}
