import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `npm run build` compiles tests/ into dist/tests/, and the release workflow builds before it
    // tests. Running those compiled copies as well doubles the suite, and anything resolving paths
    // from __dirname looks in the wrong place.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
