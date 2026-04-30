// OPIDE Extension Authentication — Phase B.B3
//
// Implements `vscode.authentication.getSession` for the providers
// extensions actually use: GitHub (for GitHub Pull Requests, Copilot,
// Codespaces) and Microsoft (for Azure, Copilot's MSA path).
//
// v1 scope
//   - In-memory session cache so multiple getSession calls in a single
//     run don't trigger repeated browser handoffs.
//   - localStorage fallback for persistence across page reloads (until
//     we have a Tauri keyring command).
//   - For unknown provider IDs we return null and log; extensions that
//     can't authenticate typically degrade gracefully.
//
// v2 will add:
//   - Real OAuth flow: open browser to provider auth URL with a
//     localhost callback the bridge listens on, exchange code → token,
//     stash in OS keychain via Tauri's keyring plugin.
//   - Token refresh on 401 from the extension's own API calls.
//   - Built-in providers as Tauri-side Rust commands so the JS
//     never sees the client secret.
//
// SECURITY: even in v1 we never let the extension see the user's
// password or full credential. Only the access token. The browser
// handles the actual sign-in.

interface StoredSession {
  id: string
  accessToken: string
  account: { id: string; label: string }
  scopes: string[]
  expiresAt?: number
}

const _memSessions = new Map<string, StoredSession>() // key = providerId + scopes
const STORAGE_PREFIX = 'opide:ext-auth:'

function sessionKey(providerId: string, scopes: string[]): string {
  return `${providerId}::${[...scopes].sort().join(',')}`
}

function loadFromStorage(providerId: string, scopes: string[]): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sessionKey(providerId, scopes))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSession
    if (parsed.expiresAt && parsed.expiresAt < Date.now()) {
      // Expired; clear it.
      localStorage.removeItem(STORAGE_PREFIX + sessionKey(providerId, scopes))
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveToStorage(providerId: string, session: StoredSession): void {
  try {
    localStorage.setItem(
      STORAGE_PREFIX + sessionKey(providerId, session.scopes),
      JSON.stringify(session),
    )
  } catch {
    // localStorage may fail in private mode etc. — degrade to in-memory only.
  }
}

export async function getSession(
  providerId: string,
  scopes: string[],
  options: { createIfNone?: boolean; forceNewSession?: boolean; clearSessionPreference?: boolean },
): Promise<any | null> {
  const key = sessionKey(providerId, scopes)

  // Cached?
  if (!options.forceNewSession) {
    const cached = _memSessions.get(key) || loadFromStorage(providerId, scopes)
    if (cached) {
      _memSessions.set(key, cached)
      return materialize(cached)
    }
  }

  if (!options.createIfNone) return null

  // v1: surface a notification to the user that an extension is
  // requesting auth, and prompt them to do the sign-in manually. v2
  // will run the OAuth dance for them.
  console.warn(`[ext-auth] Extension is requesting ${providerId} session for scopes: ${scopes.join(', ')}`)
  console.warn('[ext-auth] OAuth flow is Phase B.B3 v2 work; returning null for now.')
  return null
}

/** Convert a stored session to the VS Code AuthenticationSession shape
 * the extension expects. Kept separate so we can normalise once we
 * start storing in keyring. */
function materialize(s: StoredSession): any {
  return {
    id: s.id,
    accessToken: s.accessToken,
    account: s.account,
    scopes: s.scopes,
  }
}

/** Stash a session that was acquired through some other path (e.g. the
 * user pasted a token in a settings panel). Exposed for v2 use. */
export function setSession(providerId: string, session: StoredSession): void {
  _memSessions.set(sessionKey(providerId, session.scopes), session)
  saveToStorage(providerId, session)
}

export function clearSession(providerId: string, scopes: string[]): void {
  _memSessions.delete(sessionKey(providerId, scopes))
  try { localStorage.removeItem(STORAGE_PREFIX + sessionKey(providerId, scopes)) } catch { /* ignore */ }
}
