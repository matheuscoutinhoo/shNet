import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import base from '../../playwright.config';

const completed: { title: string }[] =
  process.env.SHLAB_AUDIT_RESUME === 'true'
    ? JSON.parse(
        readFileSync('artifacts/cisco-completeness-audit-2026-10-26/prior-browser-passes.json', 'utf8')
      )
    : [];
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const recheck = process.env.SHLAB_AUDIT_RECHECK === 'true';

export default defineConfig({
  ...base,
  fullyParallel: !recheck,
  workers: recheck ? 1 : 3,
  projects: base.projects?.filter((project) => project.name === 'sistema-claro'),
  ...(completed.length
    ? { grepInvert: new RegExp(completed.map((test) => escapePattern(test.title) + '$').join('|')) }
    : {}),
  testDir: '../../tests/e2e',
  outputDir:
    '../../.data/cisco-completeness-audit-2026-10-26/' +
    (recheck ? 'browser-recheck-results' : 'browser-results'),
  reporter: [['list'], ['json', { outputFile: recheck ? 'browser-recheck.json' : 'browser.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:5194' },
  webServer: {
    command: 'node --import tsx artifacts/cisco-completeness-audit-2026-10-26/browser-server.ts',
    cwd: '../..',
    url: 'http://127.0.0.1:5194/api/health',
    timeout: 60000,
    reuseExistingServer: false,
    env: { API_PORT: '3094', WEB_PORT: '5194' },
  },
});
