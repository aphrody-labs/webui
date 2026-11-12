// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  snapshotPathTemplate:
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-{projectName}{ext}',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3020',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'bun run start:test-api',
      url: 'http://127.0.0.1:3030/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'bun run build:deps && bun run build:client && bun run start:test-server',
      url: 'http://127.0.0.1:3020/index.js',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
