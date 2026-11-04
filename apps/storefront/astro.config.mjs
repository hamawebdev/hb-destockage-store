// Placeholder (TOOL-2). Owner: shell. Replaced by SHELL-1.
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  server: { port: 4150 },
  vite: { plugins: [tailwindcss()] },
});
