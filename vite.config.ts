import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so every asset URL — the
// bundle, the stylesheet, and the worker Vite resolves from `new URL(...)` —
// has to be prefixed. Locally the prefix is empty.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: { target: 'es2022' },
});
