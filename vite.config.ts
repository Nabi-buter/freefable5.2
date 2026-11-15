import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (GitHub Pages project sites).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
