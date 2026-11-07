import { defineConfig } from 'vite';

export default defineConfig({
  // This repository is published as a GitHub Pages project site.
  base: '/chatgptwebbuilds/',
  build: {
    rollupOptions: {
      input: {
        home: 'index.html',
        webcontainers: 'webcontainers/index.html',
        apiLab: 'api-lab/index.html'
      }
    }
  }
});