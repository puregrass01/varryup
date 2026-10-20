// 수정 버튼 라벨이 "{쇼핑몰} {상품 전체 이름} 수정하기" 로 나오는지, 상품명이 마크업으로 새지 않는지 확인한다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel) {
      if (channel === 'ebay-load-config') return { success: true, data: { environment: 'sandbox' } };
      return { success: false, error: 'Offline stub' };
    } } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
  await page.waitForTimeout(400);

  const CASES = [
    { mall: '스마트스토어', btn: 'registerBtn', nameInput: 'ssEditTitle', icon: false },
    { mall: '쿠팡', btn: 'coupangRegisterBtn', nameInput: 'cpEditTitle', icon: true },
    { mall: '아마존', btn: 'amazonRegisterBtn', nameInput: 'amzTitle', icon: true },
    { mall: '아임웹 B2B몰', btn: 'iwB2bUpdateBtn', nameInput: 'iwB2bEditTitle', icon: true, emoji: '💾' },
    { mall: '아임웹 본사·해외몰', btn: 'iwBoardUpdateBtn', nameInput: 'iwBoardEditTitle', icon: true, emoji: '💾', fallback: '게시글' },
  ];

  // 상품을 안 불러온 상태: "{쇼핑몰} 상품 수정하기"
  for (const c of CASES) {
    const text = await page.evaluate(({ btn, mall, nameInput, icon, emoji, fallback }) => {
      document.getElementById(nameInput).value = '';
      setEditButtonLabel(btn, mall, nameInput, icon ? (emoji || EDIT_ICON_SVG) : '', fallback || '상품');
      return document.getElementById(btn).textContent.trim();
    }, c);
    assert.equal(text, `${c.emoji ? c.emoji + " " : ""}${c.mall} ${c.fallback || '상품'} 수정하기`, `${c.mall} 미로딩 라벨`);
  }

  // 상품을 불러온 상태: 전체 이름이 그대로 들어간다
  const FULL = '현대 아반떼 AD 광각 열선 사이드미러 유리 운전석';
  for (const c of CASES) {
    const r = await page.evaluate(({ btn, mall, nameInput, icon, emoji, fallback, full }) => {
      document.getElementById(nameInput).value = full;
      setEditButtonLabel(btn, mall, nameInput, icon ? (emoji || EDIT_ICON_SVG) : '', fallback || '상품');
      const el = document.getElementById(btn);
      return { text: el.textContent.trim(), svg: el.querySelectorAll('svg').length };
    }, { ...c, full: FULL });
    assert.equal(r.text, `${c.emoji ? c.emoji + " " : ""}${c.mall} ${FULL} 수정하기`, `${c.mall} 로딩 후 라벨`);
    assert.equal(r.svg, (c.icon && !c.emoji) ? 1 : 0, `${c.mall} 아이콘 유지`);
  }

  // 상품명에 들어있는 마크업은 텍스트로만 남아야 한다
  const XSS = '<img src=x onerror=alert(1)> 미러';
  for (const c of CASES) {
    const r = await page.evaluate(({ btn, mall, nameInput, icon, emoji, fallback, xss }) => {
      document.getElementById(nameInput).value = xss;
      setEditButtonLabel(btn, mall, nameInput, icon ? (emoji || EDIT_ICON_SVG) : '', fallback || '상품');
      const el = document.getElementById(btn);
      return { imgs: el.querySelectorAll('img').length, text: el.textContent.includes(xss) };
    }, { ...c, xss: XSS });
    assert.equal(r.imgs, 0, `${c.mall} 상품명이 마크업으로 해석되면 안 됨`);
    assert.ok(r.text, `${c.mall} 상품명 원문 유지`);
  }

  assert.deepEqual(errors, []);
  console.log('Edit button label: passed');
} finally { await browser.close(); }
