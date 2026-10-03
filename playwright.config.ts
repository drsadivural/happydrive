import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',fullyParallel:false,workers:1,timeout:45000,
  reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],
  use:{baseURL:'http://127.0.0.1:3001',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
  webServer:[
    {command:'pnpm --filter @happydrive/api exec tsx scripts/e2e-server.ts',url:'http://127.0.0.1:8095/v1/healthz',env:{NODE_ENV:'test',HD_E2E_DATABASE_URL:process.env.HD_E2E_DATABASE_URL??''},reuseExistingServer:false},
    {command:'pnpm --filter @happydrive/partner-web dev',url:'http://127.0.0.1:3001/customer-login',env:{HD_API_BASE_URL:'http://127.0.0.1:8095/v1',HD_COOKIE_SECURE:'false'},reuseExistingServer:false},
  ],
});
