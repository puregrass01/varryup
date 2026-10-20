import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Amazon } from '../src/platforms/amazon.js';
import { AmazonAPI } from '../src/platforms/amazon_api.js';

const config = { sellerId: 'A1B2C3D4E5F6G', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh', marketplaceId: 'ATVPDKIKX0DER', endpoint: 'https://sellingpartnerapi-na.amazon.com', brand: 'Test', proxyUrl: '', proxyToken: '', awsAccessKeyId: 'old-key', awsSecretAccessKey: 'old-secret', region: 'us-east-1' };

test('legacy config retains LWA and marketplace settings while dropping IAM on read and save', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'amazon.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const amazon = new Amazon(file);
  const expected = { ...config };
  for (const key of ['awsAccessKeyId', 'awsSecretAccessKey', 'region']) delete expected[key];
  assert.deepEqual(amazon.loadConfig(), expected);
  amazon.saveConfig(config);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
});

test('connection uses LWA token without IAM signature even with legacy config', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(calls.length === 1 ? { access_token: 'access', expires_in: 3600 } : { payload: [] }), { status: 200 });
  });
  await new AmazonAPI(config).testConnection();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.amazon.com/auth/o2/token');
  assert.equal(new URLSearchParams(calls[0].options.body).get('refresh_token'), 'refresh');
  assert.equal(calls[1].options.headers['x-amz-access-token'], 'access');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers['x-amz-date'], undefined);
});

test('settings form loads and saves without removed controls; eBay connection settings remain', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext();
    await context.route(/^https?:/, route => route.abort());
    await context.addInitScript(config => {
      window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
        if (channel === 'amazon-load-config') return { success: true, config };
        if (channel === 'amazon-save-config') { window.savedAmazon = data; return { success: true }; }
        if (channel === 'ebay-load-config') return { success: true, data: { environment: 'sandbox' } };
        return { success: false, error: 'Offline stub' };
      } } });
    }, config);
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
    await page.evaluate(async () => { await loadAmazonConfig(); await saveAmazonConfig(); });
    assert.equal(await page.locator('#amzAwsKey, #amzAwsSecret, #amzRegion').count(), 0);
    const saved = await page.evaluate(() => window.savedAmazon);
    assert.equal(saved.clientSecret, config.clientSecret);
    assert.equal(saved.refreshToken, config.refreshToken);
    assert.equal(saved.marketplaceId, config.marketplaceId);
    assert.equal(saved.endpoint, config.endpoint);
    for (const key of ['awsAccessKeyId', 'awsSecretAccessKey', 'region']) assert.equal(key in saved, false);
    for (const id of ['ebEnvironment', 'ebClientId', 'ebClientSecret', 'ebRuName', 'ebRefreshToken', 'ebLocation', 'ebFulfillment', 'ebPayment', 'ebReturn']) assert.equal(await page.locator(`#${id}`).count(), 1);
  } finally { await browser.close(); }
});

test('Japan settings load, save separately and check the Japan marketplace; failed save never tests old keys', async () => {
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const context=await browser.newContext(); await context.route(/^https?:/,route=>route.abort());
    await context.addInitScript(config=>{
      window.jpCalls=[]; window.failSave=false;
      window.require=()=>({ipcRenderer:{on(){},send(){},async invoke(channel,data){
        window.jpCalls.push({channel,data});
        if(channel==='amazon-load-config') return {success:true,config:{...config,jpSellerId:'AJPSELLER12345',jpClientId:'jp-client',jpClientSecret:'jp-secret',jpRefreshToken:'jp-refresh'}};
        if(channel==='amazon-save-config') return window.failSave?{success:false,error:'저장 실패'}:{success:true};
        if(channel==='amazon-test-connection') return {success:true,message:'일본 참여 확인 완료'};
        return {success:false,error:'Offline stub'};
      }}});
    },config);
    const page=await context.newPage(); await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
    await page.evaluate(()=>loadAmazonConfig());
    assert.equal(await page.locator('#amzJpRefreshToken').inputValue(),'jp-refresh');
    assert.equal(await page.locator('#amzJpRefreshToken').getAttribute('type'),'password');
    await page.evaluate(()=>testAmazonJapanConnection());
    const calls=await page.evaluate(()=>jpCalls.filter(c=>['amazon-save-config','amazon-test-connection'].includes(c.channel)));
    assert.deepEqual(calls.map(c=>c.channel),['amazon-save-config','amazon-test-connection']);
    assert.deepEqual(calls[0].data,{jpSellerId:'AJPSELLER12345',jpClientId:'jp-client',jpClientSecret:'jp-secret',jpRefreshToken:'jp-refresh'});
    assert.equal(calls[1].data.marketplaceId,'A1VC38T7YXB528');
    assert.match(await page.locator('#amzJpStatus').textContent(),/일본 참여 확인 완료/);
    await page.evaluate(()=>{jpCalls.length=0;failSave=true;});
    await page.evaluate(()=>testAmazonJapanConnection());
    assert.equal(await page.evaluate(()=>jpCalls.some(c=>c.channel==='amazon-test-connection')),false);
    assert.equal(await page.locator('#btnTestAmzJp').isDisabled(),false);
    assert.match(await page.locator('#amzJpStatus').textContent(),/저장 실패/);
  } finally {await browser.close();}
});
