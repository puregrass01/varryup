import { app, BrowserWindow, ipcMain, session } from 'electron';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const channels = new Set(['veryup-get-mode','naver-key-config-get','ebay-load-config','currency-rates-get']);
for (const name of ['index.html','index_up.html','ebay.js','bulk-edit.js','api-key-tab.js','vu-suggest.js','image-library.js']) {
  const source = fs.readFileSync(new URL('src/ui/' + name, root), 'utf8');
  for (const match of source.matchAll(/\.invoke\(\s*['"]([^'"]+)['"]/g)) channels.add(match[1]);
}
for (const channel of channels) ipcMain.handle(channel, () => {
  if (channel === 'veryup-get-mode') return 'new';
  if (channel === 'naver-key-config-get') return {success:true,config:{clientId:'fixture-naver',hasClientSecret:true},configured:true};
  if (channel === 'coupang-load-config') return {success:true,config:{vendorId:'fixture-coupang',accessKey:'fixture-access',secretKey:'fixture-secret'}};
  if (channel === 'ebay-load-config') return {success:true,data:{environment:'sandbox'}};
  return {success:false};
});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));
  const win = new BrowserWindow({show:false,webPreferences:{
    nodeIntegration:true,contextIsolation:false,nodeIntegrationInSubframes:process.argv.includes('--with-subframes')
  }});
  await win.loadFile(fileURLToPath(new URL('src/ui/index_up.html',root)));
});
