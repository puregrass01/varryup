import { ImageLibrary } from './utils/image_library.js';

export function registerImageLibraryIPC({ app, ipcMain, dialog, output, upload }) {
  let library;
  const get = () => library ||= new ImageLibrary({ userData: app.getPath('userData'), downloads: app.getPath('downloads'), output, upload });
  const safe = fn => async (event, data = {}) => {
    try { return { success: true, ...await fn(event, data) }; }
    catch (e) { return { success: false, error: e.message }; }
  };
  ipcMain.handle('image-library-load', safe(() => ({ profiles: ['domestic', 'amazon', 'ebay'].map(id => get().scan(id)) })));
  ipcMain.handle('image-library-configure', safe((event, { id, changes }) => ({ profile: get().configure(id, changes) })));
  ipcMain.handle('image-library-pick', safe(async (event, { id, kind }) => {
    const current = get().profile(id);
    const folder = kind === 'folder';
    const result = await dialog.showOpenDialog({ title: folder ? '상세 이미지 폴더 선택' : '대표 이미지 선택', defaultPath: folder ? current.folder : current.thumbnail,
      properties: [folder ? 'openDirectory' : 'openFile'], ...(folder ? {} : { filters: [{ name: '이미지', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] }) });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { profile: get().configure(id, folder ? { folder: result.filePaths[0] } : { thumbnail: result.filePaths[0], seed: false }) };
  }));
  // 요청한 프레임에만 보낸다 — 폼(iframe) 갤러리의 업로드 진행이 셸의 [img] 패널 상태 줄을 덮어쓰지 않게.
  const progress = (event, id) => message => {
    try { if (!event.sender.isDestroyed()) event.senderFrame?.send('image-library-progress', { id, message }); } catch { /* 프레임이 닫힘 */ }
  };
  ipcMain.handle('image-library-prepare', safe((event, { id }) => get().prepare(id, progress(event, id))));
  ipcMain.handle('image-library-host-files', safe((event, { files }) => get().hostFiles(files, progress(event, 'files'))));
}
