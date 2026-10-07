import { defineConfig } from 'vitest/config';

/** Resolve workspace packages to their TypeScript sources (the `source` export condition). */
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { testTimeout: 20_000 },
});
