// Type declarations for OpenPawz modules resolved via Vite aliases.
// The actual implementations live in OpenPawz/src/* and are mapped
// through the @openpawz/* path alias in vite.config.ts.

declare module '@openpawz/engine' {
  export const pawEngine: any
}

declare module '@openpawz/state/connection' {
  export function setConnected(connected: boolean): void
}

declare module '@openpawz/views/memory-palace/index' {
  export function loadMemoryPalace(): Promise<void>
}
