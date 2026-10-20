import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/ui/theme.css"><link rel="stylesheet" href="/src/ui/bulk-edit.css">
<link rel="stylesheet" href="/src/ui/image-gallery.css"><style>body{margin:0;height:100vh;display:flex;flex-direction:column;font-family:Arial,sans-serif}#mode-bar{padding:8px}iframe{display:none}</style>
<div id="mode-bar"></div><div id="section8-body"><div id="section8-main"></div></div><iframe id="form-frame"></iframe><section id="bulk-edit-workspace"></section>
<script>var isBulkRunning=false,currentMode='edit';window.VUProductTable={normalize:r=>({brand:'옵틱글래스',vehicle:'BMW',model:'X5',kind:'광각미러'})};</script>
<script src="/src/ui/bulk-edit.js"></script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  const file = path.resolve(root, '.' + decodeURI(req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode=404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.route('https://**/*', route => route.fulfill({ contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2400"><rect width="600" height="2400" fill="#e8eef6"/><text x="40" y="80" font-size="32">Full detail image</text><text x="40" y="2320" font-size="32">End of image</text></svg>' }));
  await page.addInitScript(() => {
    window.calls=[]; window.imageFailure=false;
    window.require=()=>({ipcRenderer:{on(channel,fn){if(channel==='bulk-save-progress') window.batchEvent=fn;},async invoke(channel,data){
      calls.push({channel,data});
      if(channel==='bulk-save-batch') {
        if(window.missingBatch) throw new Error("No handler registered for 'bulk-save-batch'");
        const results=[]; let stopped='';
        for(const [index,job] of data.jobs.entries()) {
          const result=await this.invoke(job.type==='images'?'bulk-images-save':'bulk-price-save',{...job,scope:data.scope});
          const item={index,...result}; results.push(item);
          window.batchEvent?.(null,{jobId:data.jobId,scope:data.scope,result:item});
          if(!result.success && (job.type==='images'||result.stage==='unknown')) {stopped=result.error;break;}
        }
        return {success:true,data:{results,stopped,cancelled:false}};
      }
      if(channel==='bulk-price-list' && data.scope.startsWith('imweb-')) return {success:true,data:{items:[{id:'3',name:'와이드/광각미러',scope:data.scope,price:data.scope==='imweb-en'?'58':'80000',ready:false}],note:'아임웹 Open API'}};
      if(channel==='bulk-price-list' && data.scope==='amazon-us') return {success:true,data:{items:Array.from({length:52},(_,i)=>({scope:data.scope,id:String(i+1),name:'Product '+(i+1),price:i<26?(i%2?'10000.00':'10000'):i<50?'20000':i===50?'0':'',readonly:i===51,ready:false,images:i===0?'https://images.example/a.jpg?x=1&y=2|https://images.example/b.jpg':[]})),note:''}};
      if(channel==='bulk-price-list') return {success:true,data:{items:(data.scope==='coupang'?['1']:['1','2','3']).map(id=>({scope:data.scope,id,name:'Product '+id,price:'10000',ready:false})),note:''}};
      // 메인과 같이: 묶음 조회는 상품마다 행을 돌려주고, 네이버(목록 조회) 결과에는 상세 이미지가 없다.
      if(channel==='bulk-price-load-many') {
        const items=[];
        for(const id of data.ids){ const one=await this.invoke('bulk-price-load',{scope:data.scope,id,image:data.images?.[id]});
          items.push({id,rows:one.data.map(r=>data.scope==='naver'?r:{...r,images:['https://ai.esmplus.com/test/old.jpg','https://ai.esmplus.com/test/detail.jpg'],imageRevision:'old',imagesReady:true,newImages:null})}); }
        return {success:true,data:{items,blocked:''}};
      }
      if(channel==='bulk-price-load') return {success:true,data:(data.scope==='coupang'?['11','12']:['']).map(optionId=>({...data,optionId,name:'Product '+data.id,price:window.loadedPrice || '10000',ready:true,priceReadonly:data.scope==='imweb-ko'}))};
      if(channel==='bulk-images-load') return {success:true,data:{images:['https://ai.esmplus.com/test/old.jpg','https://ai.esmplus.com/test/detail.jpg'],revision:'old'}};
      if(channel==='image-library-load') return {success:true,profiles:['domestic','amazon','ebay'].map(id=>({id,items:[{role:'대표',selected:true,source:'local',url:'https://ai.esmplus.com/main.jpg'},{role:'상세',selected:true,source:'esm',url:'https://ai.esmplus.com/default.jpg'}]}))};
      if(channel==='bulk-images-import') {
        if(data.input.includes('broken')) return {success:false,error:'ESM 이미지 응답이 아닙니다'};
        const images=data.input.includes('<img')?[...new DOMParser().parseFromString(data.input,'text/html').querySelectorAll('img')].map(i=>i.getAttribute('src')):data.input.split('|');
        return {success:true,data:{images,verified:images.length}};
      }
      if(channel==='bulk-images-validate') return {success:true,data:{images:data.urls,verified:data.urls.length}};
      if(channel==='bulk-images-save') return imageFailure ? {success:false,error:'Timed out',stage:'unknown'} : {success:true,data:{status:'VERIFIED',images:data.urls,revision:'new'}};
      if(channel==='bulk-price-save') return {success:true,data:{status:'VERIFIED',price:data.newPrice}};
      throw new Error('Unexpected IPC '+channel);
    }}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#be-list').waitFor();
  const idle=()=>page.waitForFunction(()=>!document.getElementById('be-list').disabled);
  // 선택·해제 버튼은 없앴다 — 표 머리의 전체선택 체크로 고르고, 풀면 모두 해제된다.
  const selectAll=()=>page.locator('#be-th-select-all').check();
  const clearAll=async()=>{ await selectAll(); await page.locator('#be-th-select-all').uncheck(); };
  const load=async scope=>{
    await page.locator(`[data-scope="${scope}"]`).click(); await page.locator('#be-list').click(); await idle();
    await selectAll(); await page.locator('#be-load').click(); await idle();
  };
  const urls='https://ai.esmplus.com/test/new.jpg|https://ai.esmplus.com/test/2.jpg';
  await page.locator('#be-list').click(); await idle(); await selectAll();
  await page.locator('#be-image-value').fill(urls); await page.locator('#be-image-apply').click(); await idle();
  assert.match(await page.locator('#be-status').textContent(),/불러오기 완료/);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-load').length),3);
  assert.equal(await page.locator('#be-image-apply').textContent(),'이미지 불러오기');
  assert.equal(await page.locator('#be-body img').count(),6);
  assert.equal(await page.locator('#be-image-value').count(),1);
  await page.locator('#be-image-apply').click(); await idle();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel.endsWith('-save')).length),0,'apply only stages changes');
  assert.equal(await page.locator('#be-body img').first().getAttribute('src'),'https://ai.esmplus.com/test/new.jpg');
  const firstRow = page.locator('#be-body tr').first();
  await firstRow.locator('.vu-image-tile').nth(1).hover();
  await page.waitForTimeout(180);
  assert.match(await firstRow.locator('img').nth(1).evaluate(el=>getComputedStyle(el).filter),/blur/);
  assert.equal(await firstRow.locator('.vu-image-remove').nth(1).evaluate(el=>getComputedStyle(el).opacity),'1');
  await page.screenshot({path:path.join(process.env.BULK_PREVIEW_DIR || os.tmpdir(),'bulk-images-delete.png')});
  await firstRow.locator('.vu-image-remove').nth(1).click();
  assert.equal(await firstRow.locator('img').count(),1);
  assert.equal(await page.locator('#be-image-viewer').isVisible(),false,'delete does not open viewer');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-save-batch').length),0,'delete only stages');
  await page.locator('#be-search').fill('Product 1');
  await page.locator('#be-save').click(); await idle();
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-save').at(-1).data.urls),['https://ai.esmplus.com/test/new.jpg']);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-save').at(-1).data.expectedRevision),'old');
  await page.evaluate(()=>{calls.length=0;});
  await page.locator('#be-search').fill('');
  await page.locator('#be-image-value').fill(urls); await page.locator('#be-image-apply').click(); await idle();
  await page.locator('.be-image-open').first().click();
  assert.equal(await page.locator('#be-image-viewer').isVisible(),true);
  assert.equal(await page.locator('#be-image-viewer img').getAttribute('src'),'https://ai.esmplus.com/test/new.jpg');
  await page.waitForFunction(()=>document.querySelector('#be-image-viewer img').naturalHeight===2400);
  assert.ok(await page.locator('.be-image-viewer-scroll').evaluate(el=>el.scrollHeight>el.clientHeight));
  await page.screenshot({path:path.join(process.env.BULK_PREVIEW_DIR || os.tmpdir(),'bulk-images-full.png')});
  await page.getByRole('button',{name:'원본 크기',exact:true}).click();
  assert.equal(await page.locator('.be-original-size').count(),1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#be-image-viewer').isVisible(),false);
  await page.locator('#be-image-value').fill('https://ai.esmplus.com/broken.jpg');
  await page.locator('#be-image-apply').click(); await idle();
  assert.match(await page.locator('#be-status').textContent(),/응답이 아닙니다/);
  assert.equal(await page.locator('#be-body img').first().getAttribute('src'),'https://ai.esmplus.com/test/new.jpg','failed import preserves staged images');
  await page.locator('#be-image-value').fill(urls);
  const previewDir=process.env.BULK_PREVIEW_DIR || os.tmpdir();
  await page.screenshot({path:path.join(previewDir,'bulk-images-html.png')});
  await page.locator('#be-search').fill('Product 2');
  await page.locator('#be-save').click(); await idle();
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-save').map(c=>c.data.id)),['2']);
  await page.locator('#be-search').fill('');
  assert.equal(await page.locator('.be-image-pending').count(),2,'filtered-out staged changes remain');

  await load('ebay');
  assert.equal(await page.locator('#be-body img').count(),6);
  assert.match(await page.locator('.be-photo-urls').first().textContent(),/old.jpg\|https:/);
  await page.locator('#be-image-value').fill(urls); await page.locator('#be-image-apply').click(); await idle();
  await page.locator('.be-photo-urls a').first().click();
  assert.equal(await page.locator('#be-image-viewer').isVisible(),true);
  await page.getByRole('button',{name:'이미지 확대 닫기'}).click();
  await page.locator('#be-image-value').fill('<img src="https://ai.esmplus.com/html.jpg"><img src="https://ai.esmplus.com/second.jpg">');
  await page.locator('#be-image-apply').click(); await idle();
  assert.equal(await page.locator('#be-image-value').inputValue(),'https://ai.esmplus.com/html.jpg|https://ai.esmplus.com/second.jpg');
  await page.locator('#be-image-value').fill('');
  await page.locator('#be-image-apply').click(); await idle();
  assert.equal(await page.locator('#be-image-value').inputValue(),'https://ai.esmplus.com/default.jpg');
  await page.screenshot({path:path.join(previewDir,'bulk-images-urls.png')});
  await page.locator('#be-value').fill('10100'); await page.locator('#be-apply').click();
  await page.evaluate(()=>{calls.length=0; imageFailure=true;});
  await page.locator('#be-save').click(); await idle();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-save').length),1);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-price-save').length),0,'uncertain image write stops further writes');
  assert.match(await page.locator('#be-status').textContent(),/멈췄/);

  await page.evaluate(()=>{imageFailure=false; calls.length=0;});
  await load('coupang'); assert.equal(await page.locator('#be-body tr').count(),2);
  await page.locator('#be-image-value').fill(urls); await page.locator('#be-image-apply').click(); await idle();
  await page.locator('#be-body tr').first().locator('.vu-image-tile').first().hover();
  await page.locator('#be-body tr').first().locator('.vu-image-remove').first().click();
  assert.equal(await page.locator('#be-body img').count(),2,'Coupang options share remaining images');
  await page.locator('#be-save').click(); await idle();
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-save').at(-1).data.urls),['https://ai.esmplus.com/test/2.jpg']);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-save').length),1,'one image request per Coupang product');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-save-batch').length),1,'one batch submission from the UI');
  assert.equal(await page.locator('.be-image-pending').count(),0);
  // 옵션 하나만 골라 현재가를 다시 불러와도 다른 옵션이 덩달아 선택되지 않는다('가격 입력' 이 모든 옵션가를 덮던 것).
  await clearAll();
  await page.locator('#be-body tr').first().locator('input[type=checkbox]').check();
  await page.locator('#be-load').click(); await idle();
  assert.deepEqual(await page.locator('#be-body tr input[type=checkbox]').evaluateAll(boxes=>boxes.map(b=>b.checked)),[true,false],'reload keeps the single chosen option');
  await page.evaluate(()=>{calls.length=0;});
  // 아임웹 네 범위는 Open API 로 연결됐다 — 예전의 '카탈로그 참조 · API 연동 전' 잠금이 없어야 한다.
  for (const scope of ['imweb-ko','imweb-en','imweb-jp','imweb-b2b']) {
    await page.locator(`[data-scope="${scope}"]`).click();
    await page.locator('#be-list').click(); await idle();
    assert.match(await page.locator('#be-body').textContent(), /와이드\/광각미러/);
    assert.doesNotMatch(await page.locator('#be-body').textContent(), /카탈로그/);
    assert.match(await page.locator('#be-price-label').textContent(), /기존 판매가/);
    for (const id of ['be-th-select-all','be-load','be-image-apply']) assert.equal(await page.locator('#'+id).isEnabled(),true, scope+' '+id);
  }
  assert.ok(await page.evaluate(()=>calls.every(c=>c.channel==='bulk-price-list')));
  await page.locator('[data-scope="naver"]').click();
  assert.equal(await page.locator('#be-image-apply').isEnabled(),true);
  assert.equal(await page.locator('#be-image-value').inputValue(),urls,'input survives platform changes');
  // More than one page, mixed numeric representations, zero and unknown prices.
  await page.locator('[data-scope="amazon-us"]').click();
  await page.locator('#be-list').click(); await idle();
  const priceFilter=page.getByLabel('가격 필터',{exact:true});
  assert.deepEqual(await priceFilter.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['','0','10000','20000','unknown']);
  assert.equal(await page.locator('#be-body img').count(),2);
  assert.equal(await page.locator('#be-body img').first().getAttribute('src'),'https://images.example/a.jpg?x=1&y=2');
  await page.locator('#be-th-select-all').check();
  assert.match(await page.locator('#be-count').textContent(),/선택 51행/);
  await page.locator('#be-next').click();
  assert.equal(await page.locator('#be-body input[type=checkbox]:checked').count(),25);
  await page.locator('#be-next').click();
  assert.equal(await page.locator('#be-body input[type=checkbox]:checked').count(),1);
  assert.equal(await page.locator('#be-th-select-all').isChecked(),true);
  await page.locator('#be-th-select-all').uncheck();
  assert.match(await page.locator('#be-count').textContent(),/선택 0행/);
  await priceFilter.selectOption('10000');
  await page.locator('#be-th-select-all').check();
  assert.match(await page.locator('#be-count').textContent(),/선택 26행/);
  await page.locator('#be-next').click();
  assert.equal(await page.locator('#be-body input[type=checkbox]:checked').count(),1);
  await page.locator('#be-body input[type=checkbox]').first().uncheck();
  assert.equal(await page.locator('#be-th-select-all').evaluate(el=>el.indeterminate),true);
  await page.locator('#be-th-select-all').check();
  await priceFilter.selectOption('20000');
  assert.equal(await page.locator('#be-body input[type=checkbox]:checked').count(),0,'other prices are not selected');
  await priceFilter.selectOption('');
  await clearAll();
  // Current-price refresh and a verified save must refresh dropdown values.
  await page.locator('#be-body input[type=checkbox]').first().check();
  await page.evaluate(()=>{window.loadedPrice='17500';});
  await page.locator('#be-load').click(); await idle();
  assert.equal(await priceFilter.locator('option[value="17500"]').count(),1);
  await page.locator('#be-value').fill('18000'); await page.locator('#be-apply').click();
  await page.evaluate(()=>{window.missingBatch=true;});
  await page.locator('#be-save').click(); await idle();
  assert.match(await page.locator('#be-status').textContent(),/다시 실행/);
  assert.equal(await page.locator('#be-body input[type=number]').first().inputValue(),'18000');
  await page.evaluate(()=>{window.missingBatch=false;});
  await page.locator('#be-save').click(); await idle();
  assert.equal(await priceFilter.locator('option[value="18000"]').count(),1);
  assert.equal(await priceFilter.locator('option[value="17500"]').count(),0);
  await page.locator('[data-scope="imweb-en"]').click();
  assert.match(await priceFilter.locator('option[value="58"]').textContent(),/^58 USD$/);
  // 네이버 3개 현재가: 묶음 요청 한 번, 상품별 이미지 조회 없음(이미지 불러오기 때 조회).
  await page.evaluate(()=>{calls.length=0;});
  await page.locator('[data-scope="naver"]').click(); await selectAll();
  await page.locator('#be-load').click(); await idle();
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-price-load-many').map(c=>c.data.ids.length)),[3]);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-images-load').length),0);
  assert.match(await page.locator('#be-status').textContent(),/이미지 불러오기 때 상품별로 조회합니다\(3개\)/);
  await page.locator('#be-body tr').first().getByRole('button', {name:'이미지 목록 조회',exact:true}).click(); await idle();
  await page.locator('#be-body tr').first().locator('.vu-image-tile').first().hover();
  await page.locator('#be-body tr').first().locator('.vu-image-remove').first().click();
  await page.locator('#be-body tr').first().locator('.vu-image-tile').first().hover();
  await page.locator('#be-body tr').first().locator('.vu-image-remove').first().click();
  assert.equal(await page.locator('#be-body tr').first().locator('img').count(),0,'empty draft stays empty');
  const beforeEmpty = await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-save-batch').length);
  await page.locator('#be-save').click(); await idle();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.channel==='bulk-save-batch').length),beforeEmpty,'empty array cannot trigger a marketplace write');
  assert.match(await page.locator('#be-status').textContent(),/빈 항목/);
  assert.deepEqual(errors,[]);
  console.log('PASS: photo previews, pipe lists, one shared input, ESM import, HTML parsing, automatic revision load, full-image viewer, staged apply, filtered saves, uncertain-write stop, Coupang deduplication, Imweb on the Open API (no catalog lock), dynamic price filtering, all-page selection, URL previews, per-platform state.');
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
