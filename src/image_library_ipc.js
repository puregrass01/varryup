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
  ipcMain.handle('image-library-prepare', safe((event, { id }) => get().prepare(id, message => {
    if (!event.sender.isDestroyed()) event.sender.send('image-library-progress', { id, message });
  })));
}
