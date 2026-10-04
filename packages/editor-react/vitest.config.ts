import { defineConfig } from 'vitest/config';

// DOM tests opt in per file with `// @vitest-environment jsdom`
export default defineConfig({
  // jsdom suites take 1–3 s per test alone but pass 5 s when the shared box
  // runs several agents' suites at once; 15 s keeps real hangs visible
  test: { environment: 'node', testTimeout: 15_000 },
});
