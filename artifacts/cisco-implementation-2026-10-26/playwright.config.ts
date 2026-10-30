import {defineConfig} from '@playwright/test';
import base from '../../playwright.config';
const serial=process.env.SHLAB_CISCO_SERIAL==='true';
export default defineConfig({
  ...base,fullyParallel:!serial,workers:serial?1:2,
  projects:base.projects?.filter((p)=>p.name==='sistema-claro'),
  testDir:'../../tests/e2e',outputDir:serial?'../../.data/cisco-implementation-2026-10-26/browser-serial-results':'../../.data/cisco-implementation-2026-10-26/browser-results',
  reporter:[['list'],['json',{outputFile:serial?'browser-serial.json':'browser.json'}]],
  use:{...base.use,baseURL:'http://127.0.0.1:5194'},
  webServer:{command:'node --import tsx artifacts/cisco-implementation-2026-10-26/browser-server.ts',cwd:'../..',url:'http://127.0.0.1:5194/api/health',timeout:60000,reuseExistingServer:false,env:{API_PORT:'3094',WEB_PORT:'5194'}},
});
