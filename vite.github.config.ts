import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'github',
  base: '/ortho-vault/',
  plugins: [react()],
  build: {
    outDir: '../github-pages',
    emptyOutDir: true,
  },
});
