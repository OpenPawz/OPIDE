import { defineConfig } from 'vite'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 5180,
    headers: {
      // Required for SharedArrayBuffer (used by @codingame extension host worker)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // Keep @codingame chunks manageable
        manualChunks: (id) => {
          if (id.includes('@codingame/monaco-vscode-api')) return 'vscode-api'
          if (id.includes('@codingame/monaco-vscode')) return 'vscode-overrides'
        },
      },
    },
  },
  optimizeDeps: {
    // Exclude ALL @codingame packages from pre-bundling — they use dynamic imports
    exclude: [
      '@codingame/monaco-vscode-api',
      // Core platform
      '@codingame/monaco-vscode-base-service-override',
      '@codingame/monaco-vscode-host-service-override',
      '@codingame/monaco-vscode-environment-service-override',
      '@codingame/monaco-vscode-log-service-override',
      '@codingame/monaco-vscode-lifecycle-service-override',
      '@codingame/monaco-vscode-remote-agent-service-override',
      // Files, models, working copy, editor
      '@codingame/monaco-vscode-files-service-override',
      '@codingame/monaco-vscode-model-service-override',
      '@codingame/monaco-vscode-working-copy-service-override',
      '@codingame/monaco-vscode-editor-service-override',
      // Extensions
      '@codingame/monaco-vscode-extensions-service-override',
      '@codingame/monaco-vscode-extension-gallery-service-override',
      // Theme, language, syntax
      '@codingame/monaco-vscode-theme-service-override',
      '@codingame/monaco-vscode-textmate-service-override',
      '@codingame/monaco-vscode-languages-service-override',
      '@codingame/monaco-vscode-language-detection-worker-service-override',
      '@codingame/monaco-vscode-snippets-service-override',
      '@codingame/monaco-vscode-emmet-service-override',
      // Configuration, keybindings, preferences
      '@codingame/monaco-vscode-configuration-service-override',
      '@codingame/monaco-vscode-keybindings-service-override',
      '@codingame/monaco-vscode-preferences-service-override',
      // UI services
      '@codingame/monaco-vscode-markers-service-override',
      '@codingame/monaco-vscode-quickaccess-service-override',
      '@codingame/monaco-vscode-notifications-service-override',
      '@codingame/monaco-vscode-dialogs-service-override',
      '@codingame/monaco-vscode-output-service-override',
      '@codingame/monaco-vscode-accessibility-service-override',
      // Views
      '@codingame/monaco-vscode-explorer-service-override',
      '@codingame/monaco-vscode-search-service-override',
      '@codingame/monaco-vscode-scm-service-override',
      '@codingame/monaco-vscode-outline-service-override',
      '@codingame/monaco-vscode-timeline-service-override',
      '@codingame/monaco-vscode-comments-service-override',
      // Terminal
      '@codingame/monaco-vscode-terminal-service-override',
      // Storage, trust, auth, user data
      '@codingame/monaco-vscode-storage-service-override',
      '@codingame/monaco-vscode-workspace-trust-service-override',
      '@codingame/monaco-vscode-secret-storage-service-override',
      '@codingame/monaco-vscode-authentication-service-override',
      '@codingame/monaco-vscode-user-data-sync-service-override',
      '@codingame/monaco-vscode-user-data-profile-service-override',
      '@codingame/monaco-vscode-edit-sessions-service-override',
      // Debug, testing, tasks
      '@codingame/monaco-vscode-debug-service-override',
      '@codingame/monaco-vscode-testing-service-override',
      '@codingame/monaco-vscode-task-service-override',
      // Editor features
      '@codingame/monaco-vscode-multi-diff-editor-service-override',
      '@codingame/monaco-vscode-performance-service-override',
      '@codingame/monaco-vscode-localization-service-override',
      '@codingame/monaco-vscode-telemetry-service-override',
      // Welcome, chat, notebook, etc.
      '@codingame/monaco-vscode-welcome-service-override',
      '@codingame/monaco-vscode-chat-service-override',
      '@codingame/monaco-vscode-notebook-service-override',
      '@codingame/monaco-vscode-interactive-service-override',
      '@codingame/monaco-vscode-speech-service-override',
      '@codingame/monaco-vscode-update-service-override',
      '@codingame/monaco-vscode-relauncher-service-override',
      // Workbench shell
      '@codingame/monaco-vscode-workbench-service-override',
      // Default extensions (all built-in VS Code extensions)
      '@codingame/monaco-vscode-all-default-extensions',
      '@codingame/monaco-vscode-theme-defaults-default-extension',
    ],
  },
  resolve: {
    alias: {
      path: 'path-browserify',
      'monaco-editor': '@codingame/monaco-vscode-api/monaco',
      '@openpawz': path.resolve(__dirname, 'OpenPawz/src'),
    },
    dedupe: ['@codingame/monaco-vscode-api'],
  },
  worker: {
    format: 'es',
  },
})
