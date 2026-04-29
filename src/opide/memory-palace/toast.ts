// Memory Palace — minimal toast notification.
//
// Local replacement for the OpenPawz `components/toast.ts`. The original used
// anime.js + a `#global-toast` element baked into OpenPawz's index.html. OPIDE
// has neither, so we lazily inject a small toast container and animate with
// plain CSS transitions.

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

let _container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (_container) return _container;
  const c = document.createElement('div');
  c.className = 'opide-memory-palace-toast-container';
  c.style.cssText =
    'position:fixed;bottom:24px;right:24px;z-index:99999;' +
    'display:flex;flex-direction:column;gap:8px;align-items:flex-end;' +
    'pointer-events:none;font-family:var(--opide-font-ui);font-size:13px;';
  document.body.appendChild(c);
  _container = c;
  return c;
}

const KIND_COLORS: Record<ToastKind, { bg: string; fg: string; border: string }> = {
  info: { bg: '#0e639c', fg: '#fff', border: '#1177bb' },
  success: { bg: '#2d7d3a', fg: '#fff', border: '#3a9c4a' },
  error: { bg: '#a1260d', fg: '#fff', border: '#c43014' },
  warning: { bg: '#9c6e0e', fg: '#fff', border: '#bb851a' },
};

/**
 * Show a transient toast notification at the bottom-right of the viewport.
 * Auto-dismisses after `durationMs`.
 */
export function showToast(message: string, kind: ToastKind = 'info', durationMs = 3500): void {
  const c = ensureContainer();
  const colors = KIND_COLORS[kind];
  const t = document.createElement('div');
  t.textContent = message;
  t.style.cssText =
    `pointer-events:auto;padding:8px 14px;border-radius:6px;` +
    `background:${colors.bg};color:${colors.fg};border:1px solid ${colors.border};` +
    `box-shadow:0 4px 14px rgba(0,0,0,0.35);max-width:360px;word-wrap:break-word;` +
    `opacity:0;transform:translateY(8px);transition:opacity 180ms ease, transform 180ms ease;`;
  c.appendChild(t);
  // Force reflow so the transition applies
  void t.offsetHeight;
  t.style.opacity = '1';
  t.style.transform = 'translateY(0)';

  window.setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    window.setTimeout(() => {
      t.remove();
    }, 220);
  }, durationMs);
}
