import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
for (const subframes of [false, true]) {
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'vu-api-key-'));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[path.resolve('tests/fixtures/api-key-main.mjs'),'--user-data-dir='+userData,...(subframes?['--with-subframes']:[])],env,timeout:20000});
  try {
    const page=await app.firstWindow(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.locator('[data-workspace="api"]').click();
    const frame=page.frameLocator('#form-frame');
    await frame.locator('#apiKeysTab').waitFor({state:'visible',timeout:10000});
    assert.equal(await frame.locator('#aiGenTab').isVisible(),false);
    assert.equal(await frame.locator('#nvKeyId').inputValue(),'fixture-naver');
    await page.locator('label[for="mode-edit"]').click();
    // 현황판 쿠팡 칸이 켜진 채로 남아 있을 수 있다(저장된 선택) — 누르면 꺼질 수 있으니 직접 연다.
    await page.evaluate(() => checked.KOREA.open2 ? openPlatformTab('coupangTab', 'KOREA') : handleCheck('KOREA', 'open2', true, 'coupangTab'));
    await frame.locator('#coupangTab').waitFor({state:'visible'});
    await page.locator('[data-workspace="api"]').click();
    await frame.locator('#api-key-panel-coupang').waitFor({state:'visible'});
    assert.equal(await frame.locator('#cpVendorId').inputValue(),'fixture-coupang');
    assert.equal(await frame.locator('#cpSecretKey').getAttribute('type'),'password');
    assert.deepEqual(errors,[]);
    console.log('Hidden Electron API KEY passed; nodeIntegrationInSubframes='+subframes);
  } finally {
    await app.close();
    const resolved = path.resolve(userData), tempRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('vu-api-key-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
