// Memory Palace — DOM helpers.
//
// Local copies of the few utilities the view needs from the historical
// OpenPawz `components/helpers.ts`. We deliberately don't bring back the full
// OpenPawz components/ infrastructure — just the bits memory-palace actually
// uses.

/** Shorthand for `document.getElementById`. */
export const $ = (id: string): HTMLElement | null => document.getElementById(id);

/** HTML-entity-escape `s` for safe interpolation into innerHTML. */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Confirm modal ──────────────────────────────────────────────────────────
//
// Backed by a single `<dialog>` element lazily injected into the document on
// first use. We avoid relying on the OpenPawz `#confirm-modal` overlay HTML
// (which doesn't exist in OPIDE's index.html).

let _dialog: HTMLDialogElement | null = null;
let _onResolve: ((ok: boolean) => void) | null = null;

function ensureDialog(): HTMLDialogElement {
  if (_dialog) return _dialog;
  const dlg = document.createElement('dialog');
  dlg.className = 'opide-memory-palace-confirm-dialog';
  dlg.style.cssText =
    'border:1px solid var(--vscode-editorWidget-border, #444);' +
    'background:var(--vscode-editorWidget-background, #252526);' +
    'color:var(--vscode-foreground, #ccc);' +
    'border-radius:8px;padding:18px 20px;min-width:320px;max-width:480px;' +
    'font-family:var(--vscode-font-family, system-ui);font-size:13px;';
  dlg.innerHTML = `
    <h3 data-role="title" style="margin:0 0 8px 0;font-size:14px;font-weight:600"></h3>
    <p data-role="message" style="margin:0 0 16px 0;color:var(--vscode-descriptionForeground, #999)"></p>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button data-role="cancel" type="button"
        style="padding:5px 12px;border-radius:4px;border:1px solid var(--vscode-button-secondaryBorder, transparent);
        background:var(--vscode-button-secondaryBackground, #3a3d41);
        color:var(--vscode-button-secondaryForeground, #ccc);cursor:pointer">Cancel</button>
      <button data-role="ok" type="button"
        style="padding:5px 12px;border-radius:4px;border:none;
        background:var(--vscode-button-background, #0e639c);
        color:var(--vscode-button-foreground, #fff);cursor:pointer">OK</button>
    </div>`;
  document.body.appendChild(dlg);

  const finish = (ok: boolean) => {
    if (_onResolve) {
      const cb = _onResolve;
      _onResolve = null;
      cb(ok);
    }
    if (dlg.open) dlg.close();
  };

  dlg.querySelector<HTMLButtonElement>('[data-role="ok"]')!.addEventListener('click', () =>
    finish(true),
  );
  dlg.querySelector<HTMLButtonElement>('[data-role="cancel"]')!.addEventListener('click', () =>
    finish(false),
  );
  // Native ESC closes the dialog as cancel
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(false);
  });
  // Click on backdrop closes as cancel
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) finish(false);
  });

  _dialog = dlg;
  return dlg;
}

/**
 * Show a yes/no confirmation modal and resolve with the user's choice.
 * Returns false if the user cancels, escapes, or clicks the backdrop.
 */
export function confirmModal(message: string, title = 'Confirm'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const dlg = ensureDialog();
    dlg.querySelector<HTMLElement>('[data-role="title"]')!.textContent = title;
    dlg.querySelector<HTMLElement>('[data-role="message"]')!.textContent = message;
    _onResolve = resolve;
    if (!dlg.open) dlg.showModal();
    dlg.querySelector<HTMLButtonElement>('[data-role="ok"]')?.focus();
  });
}
