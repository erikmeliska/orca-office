import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,bridge,client,plugin}/src/**/*.test.ts', 'plugin/*.test.ts', 'client/test/**/*.test.ts'],
  },
});
