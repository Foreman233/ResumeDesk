import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(import.meta.url);
const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfAssets = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

export default defineConfig({
  publicDir: '.generated-public',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'resumedesk-offline-pdf-assets',
      configResolved(config) {
        const destination = resolve(config.publicDir, 'pdf-assets');
        mkdirSync(destination, { recursive: true });
        for (const folder of pdfAssets) cpSync(resolve(pdf, folder), resolve(destination, folder), { recursive: true });
      },
    },
  ],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
});
