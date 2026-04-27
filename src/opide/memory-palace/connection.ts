// Memory Palace — connection state.
//
// In OpenPawz, `isConnected()` tracked an out-of-process `pawd` server's
// liveness. OPIDE runs the engine in-process via Tauri, so the answer is
// always "yes, the backend is reachable" — failures surface as IPC errors at
// the call site, not as a top-level connection state.

/** Always true in OPIDE. The backend lives in the Tauri host process. */
export const isConnected = (): boolean => true;
