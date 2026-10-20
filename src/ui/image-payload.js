// Shared by normal registration and eBay's draft flow. Editing a published item
// deliberately retains its loaded images unless the user edits those form fields.
(() => {
  const mapping = { 'naver-register': 'domestic', 'coupang-register': 'domestic', 'amazon-register': 'amazon', 'imweb-register': 'domestic', 'ebay-save-draft': 'ebay', 'ebay-preview': 'ebay' };
  // ebay-preview: 신규 폼은 이미지 주소 칸을 숨긴다(이미지 목록이 정한다) — 미리보기도 초안과 같은 이미지로 검증한다.
  window.invokeWithImages = async (ipc, channel, data) => {
    try {
      const parent = window.parent;
      const id = mapping[channel];
      const isNew = parent !== window && parent.document.getElementById('mode-new')?.checked;
      if (!id || !isNew || data.isEditMode || data.mode === 'edit') return await ipc.invoke(channel, data);
      const library = parent.VUImages;
      if (!library) return await ipc.invoke(channel, data);
      const bundle = await library.ensure(id);
      const next = { ...data };
      if (id === 'domestic') {
        next.mainImagePath = bundle.mainImagePath;
        next.mainImageUrl = data.mainImageUrl || bundle.mainImageUrl;
        // Existing chart fields stay separate; adapters place them before the
        // selected full description instead of inserting it into old templates.
        next.detailHtml = bundle.detailHtml;
      } else if (id === 'amazon') {
        const main = document.getElementById('amzMainImageUrl');
        next.mainImageUrl = main?.dataset.vuManual === '1' ? main.value.trim() : bundle.mainImageUrl;
        const extra = document.getElementById('amzSubImages');
        next.subImages = extra?.dataset.vuManual === '1' ? extra.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : bundle.subImages;
      } else {
        const images = document.getElementById('ebImages');
        next.imageUrls = images?.dataset.vuManual === '1' ? images.value.trim() : bundle.imageUrls;
      }
      return await ipc.invoke(channel, next);
    } catch (e) { return { success: false, error: e.message }; }
  };
})();
