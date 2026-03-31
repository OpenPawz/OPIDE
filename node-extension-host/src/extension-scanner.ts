// Extension Scanner — finds and parses VS Code extensions in a directory.
// Each extension is a directory with a package.json containing:
//   - name, publisher, version, engines.vscode
//   - main (Node.js entry point) or browser (web entry point)
//   - activationEvents (when to activate)
//   - contributes (commands, languages, themes, etc.)

import * as fs from 'fs';
import * as path from 'path';

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
      };

      // Resolve entry points
      if (manifest.main) {
        ext.main = path.resolve(extDir, manifest.main);
      }
      if (manifest.browser) {
        ext.browser = path.resolve(extDir, manifest.browser);
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
