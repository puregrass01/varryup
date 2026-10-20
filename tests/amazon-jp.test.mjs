import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Amazon, JP_MARKETPLACE_ID as JP, US_MARKETPLACE_ID as US, parseListingsReport } from '../src/platforms/amazon.js';
import { AmazonStore } from '../src/platforms/amazon_store.js';
import { planAmazon } from '../src/utils/duplicate_guard.js';
const us = { sellerId:'A1B2C3D4E5F6G', clientId:'us-client', clientSecret:'us-secret', refreshToken:'us-refresh', marketplaceId:US, endpoint:'https://sellingpartnerapi-na.amazon.com' };
const jp = { jpSellerId:'AJPSELLER12345', jpClientId:'jp-client', jpClientSecret:'jp-secret', jpRefreshToken:'jp-refresh' };
const ok = data => new Response(JSON.stringify(data));
function fixture(t, config, handler) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amazon-jp-')), file=path.join(dir,'amazon.json');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); fs.writeFileSync(file,JSON.stringify(config));
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    calls.push({url:String(url),...options});
    if(String(url).includes('/auth/o2/token')) return ok({access_token:new URLSearchParams(options.body).get('refresh_token'),expires_in:3600});
    return handler(String(url),options);
  });
  const store=new AmazonStore(dir), service=new Amazon(file,store); service.runtimeProxy=null; service.loadConfig();
  return {service,store,calls};
}
const participation = id => ({marketplace:{id,name:id===JP?'Japan':'US',countryCode:id===JP?'JP':'US',defaultCurrencyCode:id===JP?'JPY':'USD'},participation:{isParticipating:true}});

test('Japan-only credentials work without a US seller or token; connection checks Japan participation',async t=>{
  const {service,calls}=fixture(t,{...jp,marketplaceId:JP},()=>ok({payload:[participation(JP)]}));
  const result=await service.testConnection(JP);
  assert.equal(result.sellerId,jp.jpSellerId); assert.equal(result.marketplaceId,JP);
  assert.equal(new URLSearchParams(calls[0].body).get('client_id'),jp.jpClientId);
  assert.equal(new URLSearchParams(calls[0].body).get('refresh_token'),jp.jpRefreshToken);
  assert.ok(calls[1].url.startsWith('https://sellingpartnerapi-fe.amazon.com/'));
  assert.equal(calls[1].headers['x-amz-access-token'],'jp-refresh');
});
test('Japan connection test rejects a Seller ID the Japan account does not accept (US ID fallback)',async t=>{
  const {service}=fixture(t,{...us,jpRefreshToken:'jp-refresh'},url=>(url.includes('/listings/')
    ? new Response(JSON.stringify({errors:[{code:'InvalidInput',message:"Invalid 'accountId' provided."}]}),{status:400})
    : ok({payload:[participation(JP)]})));
  await assert.rejects(service.testConnection(JP),/Seller ID\(A1B2C3D4E5F6G\)가 일본 판매자 계정과 맞지 않습니다.*일본 설정의 Seller ID/);
  await assert.rejects(service.apiForMarketplace(JP).getListingItem('ERHY05'),/미국과 일본은 판매자 토큰이 다릅니다/);
});
test('real Japan listings report headers are Japanese (with BOM) and carry the ASIN in 商品ID',()=>{
  const header='﻿商品名\t出品ID\t出品者SKU\t価格\t数量\t出品日\t商品IDタイプ\tコンディション説明\tコンディション\t国外へ配送可\t迅速な配送\t商品ID\t在庫数\tフルフィルメント・チャンネル\tmerchant-shipping-group\tポイント\tステータス';
  const row='パワーエレクトリック展開可能なランニングボードサイドステップ\t0929HRDA59O\tERHY05\t166477\t0\t2026/09/29 17:29:15 JST\t1\t\t11\t\t\tB0FHH87P56\t0\tDEFAULT\t移行された配送パターン\t\tInactive';
  assert.deepEqual(parseListingsReport(header+'\r\n'+row+'\r\n'),[{id:'ERHY05',name:'パワーエレクトリック展開可能なランニングボードサイドステップ',price:'166477',stock:'0',description:'',brand:'',asin:'B0FHH87P56'}]);
});
test('successful HTTP response without Japan participation is not a successful Japan connection',async t=>{
  const {service}=fixture(t,{...us,...jp},()=>ok({payload:[participation(US)]}));
  await assert.rejects(service.testConnection(JP),/판매 참여가 확인되지/);
});
test('Japan price and image updates use JP seller, FE endpoint and JPY, preserving the US offer',async t=>{
  const attrs={item_name:[{marketplace_id:JP,value:'日本商品'}],
    purchasable_offer:[{marketplace_id:JP,currency:'JPY',our_price:[{schedule:[{value_with_tax:1000}]}]},{marketplace_id:US,currency:'USD',our_price:[{schedule:[{value_with_tax:10}]}]}],
    main_product_image_locator:[{marketplace_id:JP,media_location:'https://img.example/old.jpg'}]};
  const {service,calls}=fixture(t,{...us,...jp},(url,options)=>ok(options.method==='GET'?{sku:'JP-SKU',summaries:[{marketplaceId:JP,productType:'AUTO_PART'}],attributes:attrs}:{status:'ACCEPTED'}));
  await service.updateExistingProduct({sku:'JP-SKU',marketplaceId:JP,price:'1200',currency:'JPY',replaceImageUrls:['https://img.example/new.jpg'],expectedImageUrls:['https://img.example/old.jpg']});
  const patch=calls.find(c=>c.method==='PATCH');
  assert.ok(patch.url.includes('/'+jp.jpSellerId+'/JP-SKU'));
  assert.ok(patch.url.startsWith('https://sellingpartnerapi-fe.amazon.com/'));
  const body=JSON.parse(patch.body), offers=body.patches.find(p=>p.path==='/attributes/purchasable_offer').value;
  assert.equal(offers.find(o=>o.marketplace_id===JP).currency,'JPY');
  assert.equal(offers.find(o=>o.marketplace_id===JP).our_price[0].schedule[0].value_with_tax,1200);
  assert.deepEqual(offers.find(o=>o.marketplace_id===US),attrs.purchasable_offer[1]);
  assert.equal(body.patches.find(p=>p.path==='/attributes/main_product_image_locator').value[0].media_location,'https://img.example/new.jpg');
  const api=service.apiForMarketplace(US); assert.equal(api.sellerId,us.sellerId); assert.equal(api.refreshToken,us.refreshToken);
});
test('Japan cache and duplicate registration identity use the Japan seller',async t=>{
  const {service,store}=fixture(t,{...us,...jp},()=>assert.fail('cache must not call API'));
  store.saveListingsCache({sellerId:jp.jpSellerId,marketplaceId:JP,items:[{id:'JP-SKU',price:'1200'}]});
  assert.equal(service.getCachedListings(JP).items[0].id,'JP-SKU');
  assert.equal(service.getCachedListings(US),null);
  assert.equal(planAmazon({sku:'JP-SKU',marketplaceId:JP},{config:service.config}).sellerId,jp.jpSellerId);
  service.config.jpSellerId='ADIFFERENT1234';
  assert.equal(service.getCachedListings(JP),null);
});
test('Japan report synchronization records Japan seller identity',async t=>{
  const {service,store}=fixture(t,{...us,...jp},(url,options)=>{
    if(url.endsWith('/reports/2021-06-30/reports')) return ok({reportId:'r'});
    if(url.endsWith('/reports/r')) return ok({processingStatus:'DONE',reportDocumentId:'doc'});
    if(url.endsWith('/documents/doc')) return ok({url:'https://reports.example/jp'});
    if(url==='https://reports.example/jp') return new Response('seller-sku\titem-name\tprice\nJP-SKU\t日本商品\t1200');
    assert.fail(url);
  });
  await service.refreshListingsCache({marketplaceId:JP,enrichBrand:false});
  assert.equal(store.listingsCache(JP).sellerId,jp.jpSellerId);
  assert.equal(service.getCachedListings(JP).items[0].price,'1200');
});
