const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 目标文件夹（当前目录）
const root = __dirname;

// 要创建的文件列表（内容直接在下面定义）
const files = {
  'package.json': `{
  "name": "piano-player-electron",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder"
  },
  "author": "",
  "license": "MIT",
  "dependencies": {
    "electron": "^28.0.0"
  },
  "devDependencies": {
    "electron-builder": "^24.9.1"
  },
  "build": {
    "appId": "com.yourname.pianoplayer",
    "productName": "Piano Player",
    "directories": {
      "output": "dist"
    },
    "files": [
      "main.js",
      "preload.js",
      "renderer/**/*"
    ],
    "win": {
      "target": "nsis",
      "icon": "icon.ico"
    }
  }
}`,

  'main.js': `// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'));
  // win.webContents.openDevTools();
  mainWindow = win;
  return win;
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 桥接实现 ----------
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return { themeColor: '#FF8800' }; }
}
function saveSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); }

ipcMain.handle('onThemeChanged', (_, c) => { const s = loadSettings(); s.themeColor = c; saveSettings(s); return true; });
ipcMain.handle('getThemeColor', () => loadSettings().themeColor || '#FF8800');
ipcMain.handle('onOverlayToggle', (_, v) => { console.log('[Bridge] 悬浮窗:', v); return true; });
ipcMain.handle('onAccessibilityToggle', () => { console.log('[Bridge] 辅助功能'); return true; });
ipcMain.handle('onSetFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (!r.canceled && r.filePaths.length) console.log('[Bridge] 文件夹:', r.filePaths[0]);
  return true;
});
ipcMain.handle('onImport', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }] });
  if (!r.canceled && r.filePaths.length) console.log('[Bridge] 导入:', r.filePaths[0]);
  return true;
});
ipcMain.handle('onPlayPause', () => { console.log('[Bridge] 播放/暂停'); return true; });
ipcMain.handle('onReset', () => { console.log('[Bridge] 重置'); return true; });
ipcMain.handle('onMinimize', () => { mainWindow && mainWindow.minimize(); return true; });
ipcMain.handle('onTogglePopup', () => { console.log('[Bridge] 弹出列表'); return true; });
ipcMain.handle('onClose', () => { app.quit(); return true; });
ipcMain.handle('onSpeedChange', (_, d) => { console.log('[Bridge] 倍速变化:', d); return true; });
ipcMain.handle('onSetSpeed', (_, s) => { console.log('[Bridge] 设置倍速:', s); return true; });
ipcMain.handle('onSeek', (_, r) => { console.log('[Bridge] 跳转:', r); return true; });
ipcMain.handle('onSelectItem', (_, id) => { console.log('[Bridge] 选择:', id); return true; });
ipcMain.handle('onDeleteItem', (_, id) => { console.log('[Bridge] 删除:', id); return true; });
ipcMain.handle('onDeletePopupItem', (_, id) => { console.log('[Bridge] 弹出删除:', id); return true; });
ipcMain.handle('onTrackToggle', (_, idx, en) => { console.log('[Bridge] 音轨:', idx, en); return true; });
ipcMain.handle('onPopupImport', () => { console.log('[Bridge] 弹出导入'); return true; });
ipcMain.handle('onPopupClose', () => { console.log('[Bridge] 弹出关闭'); return true; });
ipcMain.handle('onSaveImage', (_, src) => { console.log('[Bridge] 保存图片:', src); return true; });
ipcMain.handle('onDetectWindow', () => {
  console.log('[Bridge] 检测窗口');
  mainWindow.webContents.send('detect-result', { locked: true, hint: '已锁定: 示例窗口' });
  return true;
});

// 模拟进度更新（演示用）
setInterval(() => {
  if (mainWindow) {
    const p = Math.random() * 100;
    mainWindow.webContents.send('progress-update', { currentMs: p * 1000, totalMs: 120000 });
  }
}, 3000);`,

  'preload.js': `// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AndroidBridge', {
  onThemeChanged: (c) => ipcRenderer.invoke('onThemeChanged', c),
  getThemeColor: () => ipcRenderer.invoke('getThemeColor'),
  onOverlayToggle: (v) => ipcRenderer.invoke('onOverlayToggle', v),
  onAccessibilityToggle: () => ipcRenderer.invoke('onAccessibilityToggle'),
  onSetFolder: () => ipcRenderer.invoke('onSetFolder'),
  onImport: () => ipcRenderer.invoke('onImport'),
  onPlayPause: () => ipcRenderer.invoke('onPlayPause'),
  onReset: () => ipcRenderer.invoke('onReset'),
  onMinimize: () => ipcRenderer.invoke('onMinimize'),
  onTogglePopup: () => ipcRenderer.invoke('onTogglePopup'),
  onClose: () => ipcRenderer.invoke('onClose'),
  onSpeedChange: (d) => ipcRenderer.invoke('onSpeedChange', d),
  onSetSpeed: (s) => ipcRenderer.invoke('onSetSpeed', s),
  onSeek: (r) => ipcRenderer.invoke('onSeek', r),
  onSelectItem: (id) => ipcRenderer.invoke('onSelectItem', id),
  onDeleteItem: (id) => ipcRenderer.invoke('onDeleteItem', id),
  onDeletePopupItem: (id) => ipcRenderer.invoke('onDeletePopupItem', id),
  onTrackToggle: (idx, en) => ipcRenderer.invoke('onTrackToggle', idx, en),
  onPopupImport: () => ipcRenderer.invoke('onPopupImport'),
  onPopupClose: () => ipcRenderer.invoke('onPopupClose'),
  onSaveImage: (src) => ipcRenderer.invoke('onSaveImage', src),
  onDetectWindow: () => ipcRenderer.invoke('onDetectWindow'),
});

contextBridge.exposeInMainWorld('electronAPI', {
  onUpdatePlaylist: (cb) => ipcRenderer.on('update-playlist', (_, d) => cb(d)),
  onDetectResult: (cb) => ipcRenderer.on('detect-result', (_, d) => cb(d)),
  onProgressUpdate: (cb) => ipcRenderer.on('progress-update', (_, d) => cb(d)),
});`,

  // 你提供的 UI 文件（直接复制你的完整 HTML，但为了节省篇幅这里只写一个占位，实际运行必须用你的完整文件）
  // 为了让脚本直接可用，我们会从你粘贴的原始文件中读取，但这里由于无法自动获取，建议你手动将你的 HTML 文件命名为 ui_preview_landscape.html 放入 renderer 文件夹。
  // 但生成脚本时，我们可以创建一个临时文件，内容为提示你手动复制。
  'renderer/ui_preview_landscape.html': `<!-- 请将你提供的 ui_preview_landscape.html 完整内容复制到此文件 -->`
};

// 创建文件夹
if (!fs.existsSync(path.join(root, 'renderer'))) {
  fs.mkdirSync(path.join(root, 'renderer'));
}

// 写入文件
Object.entries(files).forEach(([filepath, content]) => {
  const fullPath = path.join(root, filepath);
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`✅ 已创建: ${filepath}`);
});

console.log('\n📦 正在安装依赖 (npm install)...');
try {
  execSync('npm install', { stdio: 'inherit', cwd: root });
  console.log('\n🎉 安装完成！现在运行 npm start 启动应用。');
} catch (e) {
  console.error('❌ 安装依赖失败，请手动运行 npm install');
}