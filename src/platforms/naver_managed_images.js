import fs from 'node:fs';

// New/copy registration still uses the existing seller-center flow. Limit the
// native file upload to the representative-image control and fail before Save
// if Naver changes that control, instead of keeping an unrelated template photo.
export async function uploadRepresentative(page, file) {
  if (!fs.existsSync(file)) throw new Error('네이버 대표 이미지 파일을 찾을 수 없습니다.');
  let section = page.locator('[ng-model="product.images.representativeImage"], [data-field="representativeImage"]').first();
  if (!await section.count()) {
    section = page.getByText('대표이미지', { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"form-group")][1]');
  }
  if (!await section.count()) throw new Error('네이버 대표이미지 업로드 영역을 찾지 못했습니다. 상품은 저장하지 않았습니다.');
  const old = await section.locator('img').first().getAttribute('src').catch(() => '');
  const input = section.locator('input[type="file"]').first();
  if (await input.count()) await input.setInputFiles(file);
  else {
    const change = section.getByRole('button', { name: /변경|등록|추가/ }).first();
    if (!await change.count()) throw new Error('네이버 대표이미지 파일 선택 버튼을 찾지 못했습니다. 상품은 저장하지 않았습니다.');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), change.click()]);
    await chooser.setFiles(file);
  }
  const handle = await section.elementHandle();
  await page.waitForFunction(({ root, old }) => {
    const img = root.querySelector('img');
    return img?.getAttribute('src') && img.getAttribute('src') !== old && img.complete && img.naturalWidth > 0;
  }, { root: handle, old }, { timeout: 20000 }).catch(() => {
    throw new Error('네이버 대표이미지 업로드 완료를 확인하지 못했습니다. 상품은 저장하지 않았습니다.');
  });
}

export async function replaceDescriptionImages(editor, html) {
  const content = editor.locator('.se-document .se-text-paragraph, .se-document .se-component').first();
  if (!await content.count()) throw new Error('네이버 상세설명 편집 영역을 찾지 못했습니다.');
  await content.click();
  await editor.keyboard.press('Control+Home');
  await editor.keyboard.press('Control+A');
  await editor.keyboard.press('Control+A');
  await editor.keyboard.press('Backspace');
  const attach = editor.locator('.se-shopping-html-toolbar-button').first();
  await attach.click();
  const textarea = editor.locator('textarea#textarea');
  await textarea.fill(html);
  await editor.locator('.modal-dialog .modal-footer button.btn-primary:has-text("변환")').click();
  await editor.locator('.se-image-resource').first().waitFor({ state: 'visible', timeout: 15000 });
  // Verify all selected URLs were converted and no old image components remain.
  const expected = [...html.matchAll(/<img[^>]*src=["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  const actual = await editor.locator('.se-image-resource').evaluateAll(imgs => imgs.map(i => i.getAttribute('src')));
  if (actual.length !== expected.length || expected.some((u, i) => actual[i] !== u)) {
    throw new Error('네이버 상세 이미지 변환 결과가 선택 목록과 다릅니다. 상품은 저장하지 않았습니다.');
  }
  await editor.locator('button:has-text("등록"), a:has-text("등록")').first().click();
}
