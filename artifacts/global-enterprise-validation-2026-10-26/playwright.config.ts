import {defineConfig} from '@playwright/test';
import base from '../../playwright.config';
export default defineConfig({
 ...base,testDir:'.',testMatch:'enterprise-ui.spec.ts',timeout:240000,fullyParallel:false,workers:1,
 projects:[{name:'enterprise-desktop',use:{viewport:{width:1600,height:1100}}}],
 outputDir:'../../.data/global-enterprise-validation-2026-10-26/browser-final-results',
 reporter:[['list'],['json',{outputFile:'browser-results.json'}]],
 use:{...base.use,baseURL:'http://127.0.0.1:5194'},webServer:undefined,
});
