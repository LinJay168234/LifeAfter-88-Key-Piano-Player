const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const pianoKeys = require('./pianoKeys');

let pythonProc = null;
let pythonReady = false;
let pendingRequests = new Map();
let requestId = 0;
let isExeMode = false;
let pyExec = null;
let pyScript = null;

function detectPythonEnv() {
    if (app.isPackaged) {
        const exePath = path.join(process.resourcesPath, 'midi_controller.exe');
        const scriptPath = path.join(process.resourcesPath, 'midi_controller.py');
        if (fs.existsSync(exePath)) {
            pyScript = exePath;
            isExeMode = true;
        } else if (fs.existsSync(scriptPath)) {
            pyScript = scriptPath;
            pyExec = findPython();
        }
    } else {
        pyScript = path.join(__dirname, 'midi_controller.py');
        pyExec = findPython();
    }
}

function findPython() {
    const cmds = ['python', 'python3', 'py'];
    for (const cmd of cmds) {
        try {
            execSync(`${cmd} --version`, { stdio: 'ignore' });
            return cmd;
        } catch (e) {}
    }
    return null;
}

function startPythonService() {
    if (pythonProc) {
        try { pythonProc.kill(); } catch(e) {}
        pythonProc = null;
    }
    
    if (!isExeMode && (!pyExec || !pyScript || !fs.existsSync(pyScript))) {
        console.error('Python env not found');
        return;
    }

    const args = isExeMode ? [] : [pyScript];
    const cmd = isExeMode ? pyScript : pyExec;
    
    pythonProc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    
    let buffer = '';
    pythonProc.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const result = JSON.parse(trimmed);
                const firstKey = pendingRequests.keys().next().value;
                if (firstKey !== undefined) {
                    const { resolve, timeout } = pendingRequests.get(firstKey);
                    clearTimeout(timeout);
                    pendingRequests.delete(firstKey);
                    resolve(result);
                }
            } catch (e) {
                console.error('Parse error:', trimmed);
            }
        }
    });
    
    pythonProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.log(`[Python] ${msg}`);
    });
    
    pythonProc.on('close', (code) => {
        pythonProc = null;
        pythonReady = false;
        for (const [id, { resolve, timeout }] of pendingRequests) {
            clearTimeout(timeout);
            resolve({ error: 'Process exited' });
        }
        pendingRequests.clear();
    });
    
    pythonReady = true;
}

function callPython(command, data = {}, timeoutMs = 10000) {
    return new Promise((resolve) => {
        if (!pythonProc || !pythonReady) {
            startPythonService();
            if (!pythonProc) return resolve({ error: 'Service unavailable' });
        }
        
        const id = ++requestId;
        const inputData = { command, ...data };
        const jsonInput = Buffer.from(JSON.stringify(inputData) + '\n', 'utf8');
        
        const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                resolve({ error: 'Timeout' });
            }
        }, timeoutMs);
        
        pendingRequests.set(id, { resolve, timeout });
        
        try {
            pythonProc.stdin.write(jsonInput);
        } catch (e) {
            clearTimeout(timeout);
            pendingRequests.delete(id);
            resolve({ error: e.message });
        }
    });
}

app.setName('MIDI钢琴播放器');
Menu.setApplicationMenu(null);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');

let mainWindow = null;
let floatWindow = null;
let popupWindow = null;
let isFloatVisible = false;
let isShortcutRegistered = false;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return { themeColor: '#FF8800', folderPath: '' }; }
};
const saveSettings = (s) => fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));

let player = {
    isPlaying: false,
    speed: 1.0,
    currentTime: 0,
    totalDuration: 120,
    currentId: null,
    playlist: [],
    folderPath: '',
};

let detectCountdown = null;
let progressTracker = null;
let isPlaybackEnded = false;
let cachedTracks = [];
let targetWindowInfo = { locked: false, hwnd: null };

const HINT_PLAY = '空格键 播放，双击重置';
const HINT_PAUSE = '空格键 暂停，双击重置';

const getLoadedStatus = () => player.currentId ? `已加载　${HINT_PLAY}` : `请导入 .mid 文件　${HINT_PLAY}`;
const isWindowLocked = () => !!targetWindowInfo.locked;

async function detectWindowPython() {
    return await callPython('detect', {}, 10000);
}

async function getWindowInfoPython() {
    return await callPython('info', {}, 5000);
}

async function loadMidiPython(filePath) {
    if (!fs.existsSync(filePath)) return { success: false };
    const result = await callPython('load', { filePath });
    if (result && result.success) {
        if (result.totalDuration) player.totalDuration = result.totalDuration;
        if (result.tracks) {
            cachedTracks = result.tracks;
            broadcast('update-tracks', result.tracks);
        }
    }
    return result;
}

async function playMidiPython() {
    if (!isWindowLocked()) {
        broadcast('play-state-changed', false);
        return;
    }
    const result = await callPython('play');
    if (result && result.success !== false) {
        player.isPlaying = true;
        isPlaybackEnded = false;
        broadcast('play-state-changed', true);
        broadcast('set-status', `播放中　${HINT_PAUSE}`);
        if (!progressTracker) startProgressTracking();
    }
}

async function pauseMidiPython() {
    await callPython('pause');
    player.isPlaying = false;
    broadcast('play-state-changed', false);
    broadcast('set-status', `已暂停　${HINT_PLAY}`);
}

async function stopMidiPython() {
    await callPython('stop');
    player.isPlaying = false;
    player.currentTime = 0;
    isPlaybackEnded = false;
    broadcast('play-state-changed', false);
    broadcast('progress-update', { currentMs: 0, totalMs: player.totalDuration });
    broadcast('set-status', getLoadedStatus());
    if (progressTracker) {
        clearInterval(progressTracker);
        progressTracker = null;
    }
}

async function seekMidiPython(ratio) {
    await callPython('seek', { ratio });
}

async function setSpeedPython(speed) {
    await callPython('speed', { speed });
    player.speed = speed;
    broadcast('speed-changed', speed);
}

async function getStatePython() {
    const result = await callPython('state');
    if (result && result.totalDuration !== undefined) {
        player.currentTime = result.currentTime || 0;
        if (result.totalDuration > 0) player.totalDuration = result.totalDuration;
        broadcast('progress-update', { currentMs: player.currentTime, totalMs: player.totalDuration });
    }
    return result;
}

async function toggleTrackPython(index) {
    return await callPython('toggle_track', { index });
}

function startProgressTracking() {
    if (progressTracker) clearInterval(progressTracker);
    isPlaybackEnded = false;
    progressTracker = setInterval(async () => {
        const state = await getStatePython();
        if (state && state.isPlaying === false && !isPlaybackEnded && player.isPlaying) {
            isPlaybackEnded = true;
            player.isPlaying = false;
            player.currentTime = 0;
            await callPython('stop');
            broadcast('play-state-changed', false);
            broadcast('set-status', `已加载　${HINT_PLAY}`);
            broadcast('progress-update', { currentMs: 0, totalMs: player.totalDuration });
            clearInterval(progressTracker);
            progressTracker = null;
        }
    }, 500);
}

async function startDetectCountdown() {
    if (detectCountdown) clearInterval(detectCountdown);
    let countdown = 5;
    
    detectCountdown = setInterval(async () => {
        countdown--;
        if (countdown > 0) return;
        clearInterval(detectCountdown);
        detectCountdown = null;
        
        const result = await detectWindowPython();
        if (result && result.success) {
            targetWindowInfo.locked = true;
            broadcast('set-status', `已暂停　${HINT_PLAY}`);
            
            const info = await getWindowInfoPython();
            if (info && info.available) {
                targetWindowInfo.hwnd = info.hwnd;
                broadcast('detect-result', { locked: true, hint: `已锁定: ${info.title}` });
                if (floatWindow) floatWindow.webContents.executeJavaScript(`document.getElementById('btn-detect-window')?.classList.add('locked');`).catch(()=>{});
            } else {
                targetWindowInfo.hwnd = null;
                broadcast('detect-result', { locked: true, hint: `已锁定: ${result.title}` });
                if (floatWindow) floatWindow.webContents.executeJavaScript(`document.getElementById('btn-detect-window')?.classList.add('locked');`).catch(()=>{});
            }
        } else {
            targetWindowInfo.locked = false;
            broadcast('detect-result', { locked: false, hint: '未检测到窗口' });
            if (floatWindow) floatWindow.webContents.executeJavaScript(`document.getElementById('btn-detect-window')?.classList.remove('locked');`).catch(()=>{});
        }
    }, 1000);
}

function broadcast(channel, ...args) {
    [mainWindow, floatWindow, popupWindow].filter(w => w && !w.isDestroyed()).forEach(win => {
        try { win.webContents.send(channel, ...args); } catch (e) {}
    });
}

function updatePlaylistUI(list, currentId) {
    broadcast('update-playlist', list, currentId);
    if (mainWindow) mainWindow.webContents.executeJavaScript(`window.PianoUI?.setPlaylist(${JSON.stringify(list)}, ${JSON.stringify(currentId)})`).catch(()=>{});
    if (popupWindow) popupWindow.webContents.executeJavaScript(`window.PianoUI?.setPopupList(${JSON.stringify(list)}, ${JSON.stringify(currentId)})`).catch(()=>{});
}

function savePlaylist() {
    const settings = loadSettings();
    settings.playlist = player.playlist;
    settings.currentId = player.currentId;
    settings.folderPath = player.folderPath;
    saveSettings(settings);
}

function syncProgress(currentMs, totalMs) {
    broadcast('progress-update', { currentMs, totalMs });
    if (floatWindow) floatWindow.webContents.executeJavaScript(`window.PianoUI?.setProgress(${currentMs}, ${totalMs})`).catch(()=>{});
}

function syncTracks(tracks) {
    cachedTracks = tracks || [];
    broadcast('update-tracks', cachedTracks);
}

function loadItem(id) {
    const item = player.playlist.find(i => i.id === id);
    if (!item) return false;
    
    if (player.isPlaying) callPython('stop');
    player.currentId = id;
    player.currentTime = 0;
    player.totalDuration = 0;
    
    broadcast('set-title', item.name, '');
    updatePlaylistUI(player.playlist, id);
    savePlaylist();
    
    loadMidiPython(item.filePath).then((result) => {
        if (result && result.success) {
            player.totalDuration = result.totalDuration || 120000;
            syncProgress(0, player.totalDuration);
            broadcast('play-state-changed', false);
            broadcast('set-status', `已加载　${HINT_PLAY}`);
        } else {
            broadcast('set-status', getLoadedStatus());
        }
    });
    return true;
}

function playItem(id) {
    const item = player.playlist.find(i => i.id === id);
    if (!item) return;
    
    if (player.isPlaying) callPython('stop');
    player.currentId = id;
    player.currentTime = 0;
    player.totalDuration = 0;
    
    broadcast('set-title', item.name, '');
    updatePlaylistUI(player.playlist, id);
    savePlaylist();
    
    loadMidiPython(item.filePath).then((result) => {
        if (result && result.success) {
            player.totalDuration = result.totalDuration || 120000;
            syncProgress(0, player.totalDuration);
            setTimeout(() => playMidiPython(), 200);
        } else {
            broadcast('set-status', getLoadedStatus());
        }
    });
}

function createFloatWindow() {
    if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.focus();
        return;
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
        width: 420, height: 520,
        x: Math.round((width - 420) / 2), y: Math.round((height - 520) / 2),
        alwaysOnTop: true, transparent: true, frame: false, resizable: false,
        skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000', show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false, zoomFactor: 1.38,
        },
    });
    const color = loadSettings().themeColor || '#FF8800';
    win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'), { query: { view: 'float', theme: color } });
    
    win.webContents.on('did-finish-load', async () => {
        win.webContents.insertCSS(`.grabber{-webkit-app-region:drag}.grabber-bar,.grabber-text{pointer-events:none}html,body{background:transparent!important;margin:0;padding:0}.float-root{margin:0}`);
        win.webContents.send('set-float-mode', true);
        
        let tracks = cachedTracks;
        if (!tracks || tracks.length === 0) {
            const res = await callPython('tracks');
            if (res && res.tracks) { tracks = res.tracks; cachedTracks = tracks; }
        }
        
        win.webContents.executeJavaScript(`
            (function() {
                const themeColor = new URLSearchParams(location.search).get('theme') || '#FF8800';
                if (typeof applyAccent === 'function') applyAccent(themeColor);
                const grabber = document.getElementById('float-drag');
                if (grabber) grabber.style.webkitAppRegion = 'drag';
                
                window.PianoUI?.setPlaylist(${JSON.stringify(player.playlist)}, ${JSON.stringify(player.currentId)});
                const cur = ${JSON.stringify(player.playlist.find(i => i.id === player.currentId))};
                window.PianoUI?.setTitle(cur ? cur.name : '未选择乐曲', '');
                window.PianoUI?.setTracks(${JSON.stringify(tracks || [])});
                window.PianoUI?.setProgress(${player.currentTime || 0}, ${player.totalDuration || 120000});
                window.PianoUI?.setPlaying(${player.isPlaying});
                window.PianoUI?.setStatusText(${JSON.stringify(getLoadedStatus())});
                window.PianoUI?.setDetectLocked(${targetWindowInfo.locked === true});
                
                document.body.style.transition = 'opacity 0.15s ease';
                document.body.style.opacity = '1';
            })();
        `).catch(()=>{});
        win.show();
    });
    win.on('closed', () => {
        floatWindow = null;
        isFloatVisible = false;
        unregisterGlobalShortcut();
        if (mainWindow) mainWindow.webContents.send('overlay-state-changed', false);
    });
    win.on('show', () => { isFloatVisible = true; registerGlobalShortcut(); });
    win.on('hide', () => { isFloatVisible = false; unregisterGlobalShortcut(); });
    
    floatWindow = win;
    isFloatVisible = true;
    registerGlobalShortcut();
}

function closeFloatWindow() {
    if (floatWindow && !floatWindow.isDestroyed()) {
        unregisterGlobalShortcut();
        floatWindow.close();
        floatWindow = null;
        isFloatVisible = false;
        if (mainWindow) mainWindow.webContents.send('overlay-state-changed', false);
    }
}

function createPopupWindow() {
    if (popupWindow && !popupWindow.isDestroyed()) { popupWindow.focus(); return; }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    let x = floatWindow ? floatWindow.getBounds().x + floatWindow.getBounds().width + 10 : Math.round((width - 420) / 2);
    let y = floatWindow ? floatWindow.getBounds().y : Math.round((height - 540) / 2);
    if (x + 420 > width) x = floatWindow.getBounds().x - 430;
    
    const win = new BrowserWindow({
        width: 420, height: 540, x, y,
        alwaysOnTop: true, transparent: true, frame: false, resizable: false,
        skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000', show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false, zoomFactor: 1.38,
        },
    });
    const color = loadSettings().themeColor || '#FF8800';
    win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'), { query: { view: 'popup', theme: color } });
    
    win.webContents.on('did-finish-load', () => {
        win.webContents.insertCSS(`html,body{margin:0;padding:0;background:transparent!important}.popup-root{margin:0;width:100%;height:100%}`);
        win.webContents.executeJavaScript(`
            (function() {
                const themeColor = new URLSearchParams(location.search).get('theme') || '#FF8800';
                if (typeof applyAccent === 'function') applyAccent(themeColor);
                window.PianoUI?.setPopupList(${JSON.stringify(player.playlist)}, ${JSON.stringify(player.currentId)});
                document.body.style.transition = 'opacity 0.15s ease';
                document.body.style.opacity = '1';
            })();
        `).catch(()=>{});
        win.show();
    });
    win.on('blur', () => setTimeout(() => closePopupWindow(), 50));
    win.on('closed', () => { popupWindow = null; });
    popupWindow = win;
}

function closePopupWindow() {
    if (popupWindow && !popupWindow.isDestroyed()) { popupWindow.close(); popupWindow = null; }
}

function createMainWindow() {
    const win = new BrowserWindow({
        width: 1000, height: 720, resizable: false, maximizable: false, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.setTitle('MIDI钢琴播放器');
    
    const iconPath = path.join(__dirname, 'icon.ico');
    const pngPath = path.join(__dirname, 'icon.png');
    try { if (fs.existsSync(iconPath)) win.setIcon(iconPath); else if (fs.existsSync(pngPath)) win.setIcon(pngPath); } catch(e){}
    
    win.webContents.on('did-finish-load', () => {
        win.focus();
        win.webContents.focus();
        win.webContents.executeJavaScript(`document.body.style.opacity='1';document.body.focus();`).catch(()=>{});
        win.show();
    });
    win.on('focus', () => {
        win.webContents.focus();
        win.webContents.executeJavaScript('document.body.focus();').catch(()=>{});
    });
    win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'));
    win.on('close', () => {
        if (floatWindow) floatWindow.close();
        if (popupWindow) popupWindow.close();
        callPython('reset');
    });
    mainWindow = win;
}

async function handleImport() {
    if (!player.folderPath || !fs.existsSync(player.folderPath)) {
        broadcast('set-status', '请先设置文件夹');
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '请先选择 MIDI 文件夹' });
        if (r.canceled || !r.filePaths.length) { broadcast('set-status', getLoadedStatus()); return false; }
        player.folderPath = r.filePaths[0];
        try {
            const files = fs.readdirSync(player.folderPath).filter(f => /\.(mid|midi)$/i.test(f));
            player.playlist = player.playlist.concat(files.map((f, i) => ({ id: Date.now() + '_' + i, name: f, filePath: path.join(player.folderPath, f) })));
            savePlaylist();
            updatePlaylistUI(player.playlist, player.currentId);
            broadcast('set-status', getLoadedStatus());
        } catch(e) { broadcast('set-status', getLoadedStatus()); return false; }
    }
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }], defaultPath: player.folderPath });
    if (!r.canceled && r.filePaths.length) {
        const filePath = r.filePaths[0];
        const name = path.basename(filePath);
        const newItem = { id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), name, filePath };
        player.playlist.push(newItem);
        savePlaylist();
        updatePlaylistUI(player.playlist, player.currentId);
        player.currentId = newItem.id;
        
        const result = await loadMidiPython(filePath);
        if (result && result.success) {
            player.totalDuration = result.totalDuration || 120000;
            syncProgress(0, player.totalDuration);
            broadcast('set-title', name, '');
            broadcast('play-state-changed', false);
            broadcast('set-status', `已加载　${HINT_PLAY}`);
        } else {
            broadcast('set-status', getLoadedStatus());
        }
        return true;
    }
    return false;
}

let globalKeyState = { space: false };
let globalKeyTimer = null;

function doGlobalPlayPause() {
    if (!isFloatVisible) return;
    getStatePython().then(state => {
        if (state && state.isPlaying) {
            pauseMidiPython();
        } else {
            if (!isWindowLocked()) return;
            if (player.totalDuration > 0) playMidiPython();
            else if (player.currentId) {
                const item = player.playlist.find(i => i.id === player.currentId);
                if (item) loadMidiPython(item.filePath).then(res => {
                    if (res && res.totalDuration) { player.totalDuration = res.totalDuration; syncProgress(0, res.totalDuration); }
                    setTimeout(() => playMidiPython(), 200);
                });
            } else if (player.playlist.length > 0) playItem(player.playlist[0].id);
        }
    });
}

function handleGlobalKeyPress() {
    if (!isFloatVisible) return;
    if (globalKeyState.space) {
        clearTimeout(globalKeyTimer);
        globalKeyState.space = false;
        stopMidiPython();
        return;
    }
    globalKeyState.space = true;
    globalKeyTimer = setTimeout(() => {
        if (globalKeyState.space) doGlobalPlayPause();
        globalKeyState.space = false;
    }, 300);
}

function registerGlobalShortcut() {
    if (isShortcutRegistered) return;
    isShortcutRegistered = globalShortcut.register('Space', handleGlobalKeyPress);
}

function unregisterGlobalShortcut() {
    if (isShortcutRegistered) {
        globalShortcut.unregister('Space');
        isShortcutRegistered = false;
        globalKeyState.space = false;
        clearTimeout(globalKeyTimer);
    }
}

app.whenReady().then(() => {
    detectPythonEnv();
    startPythonService();
    
    const settings = loadSettings();
    player.playlist = settings.playlist || [];
    player.currentId = settings.currentId || null;
    player.folderPath = settings.folderPath || '';
    
    createMainWindow();
    
    setTimeout(() => {
        updatePlaylistUI(player.playlist, player.currentId);
        if (player.currentId) {
            const item = player.playlist.find(i => i.id === player.currentId);
            if (item) loadMidiPython(item.filePath).then(res => {
                broadcast('set-title', item.name, '');
                if (res && res.totalDuration) { player.totalDuration = res.totalDuration; syncProgress(0, res.totalDuration); }
                broadcast('set-status', `已加载　${HINT_PLAY}`);
                broadcast('play-state-changed', false);
            });
        } else {
            broadcast('set-status', getLoadedStatus());
        }
    }, 500);
});

app.on('window-all-closed', () => {
    if (detectCountdown) clearInterval(detectCountdown);
    if (progressTracker) clearInterval(progressTracker);
    unregisterGlobalShortcut();
    if (pythonProc) {
        try { pythonProc.stdin.write(JSON.stringify({ command: 'exit' }) + '\n'); setTimeout(() => pythonProc.kill(), 500); } catch(e){}
    }
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (pythonProc) try { pythonProc.kill(); } catch(e){}
});

// IPC
ipcMain.handle('getPianoKeys', () => pianoKeys.getPianoKeys());
ipcMain.handle('getPianoKey', (_, note) => pianoKeys.getPianoKey(note));
ipcMain.handle('getNoteName', (_, note) => pianoKeys.getNoteName(note));
ipcMain.handle('findKeyByScreenPos', (_, x, y) => pianoKeys.findKeyByScreenPos(x, y));
ipcMain.handle('getScaleFactors', () => pianoKeys.getScaleFactors());

ipcMain.handle('loadMidiFile', async (_, filePath) => {
    const res = await loadMidiPython(filePath);
    if (res && res.success) {
        player.totalDuration = res.totalDuration || 120000;
        broadcast('set-title', path.basename(filePath), '');
        syncProgress(0, player.totalDuration);
        broadcast('play-state-changed', false);
        broadcast('set-status', `已加载　${HINT_PLAY}`);
    }
    return res;
});

ipcMain.handle('playMidi', async () => { player.isPlaying ? await pauseMidiPython() : await playMidiPython(); return true; });
ipcMain.handle('stopMidi', async () => { await stopMidiPython(); return true; });
ipcMain.handle('seekMidi', async (_, r) => { await seekMidiPython(r); return true; });
ipcMain.handle('setMidiSpeed', async (_, s) => { await setSpeedPython(s); return true; });
ipcMain.handle('getMidiState', async () => await getStatePython());
ipcMain.handle('toggleTrackMute', async (_, i) => { const r = await toggleTrackPython(i); if (r && r.tracks) syncTracks(r.tracks); return r.muted; });

ipcMain.handle('onSetFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths.length) {
        player.folderPath = r.filePaths[0];
        const files = fs.readdirSync(player.folderPath).filter(f => /\.(mid|midi)$/i.test(f));
        player.playlist = player.playlist.concat(files.map((f, i) => ({ id: Date.now() + '_' + i, name: f, filePath: path.join(player.folderPath, f) })));
        savePlaylist();
        updatePlaylistUI(player.playlist, player.currentId);
        broadcast('set-status', getLoadedStatus());
        return true;
    }
    return false;
});

ipcMain.handle('onImport', handleImport);
ipcMain.handle('onPopupImport', handleImport);

ipcMain.handle('onThemeChanged', (_, color) => {
    const s = loadSettings(); s.themeColor = color; saveSettings(s);
    broadcast('theme-changed', color);
    return true;
});
ipcMain.handle('getThemeColor', () => loadSettings().themeColor || '#FF8800');

ipcMain.handle('onOverlayToggle', (_, checked) => {
    if (checked) { createFloatWindow(); closePopupWindow(); }
    else { closeFloatWindow(); closePopupWindow(); }
    return true;
});

ipcMain.handle('onTogglePopup', () => {
    popupWindow && !popupWindow.isDestroyed() ? closePopupWindow() : createPopupWindow();
    return true;
});

ipcMain.handle('onPlayPause', async () => {
    if (!isFloatVisible) return false;
    const state = await getStatePython();
    if (state && state.isPlaying) await pauseMidiPython();
    else if (isWindowLocked()) {
        if (player.totalDuration > 0) await playMidiPython();
        else if (player.currentId) {
            const item = player.playlist.find(i => i.id === player.currentId);
            if (item) {
                const res = await loadMidiPython(item.filePath);
                if (res && res.totalDuration) { player.totalDuration = res.totalDuration; syncProgress(0, res.totalDuration); }
                setTimeout(async () => await playMidiPython(), 200);
            }
        } else if (player.playlist.length > 0) playItem(player.playlist[0].id);
    }
    return true;
});

ipcMain.handle('onReset', async () => { if (isFloatVisible) await stopMidiPython(); return true; });

ipcMain.handle('onMinimize', () => {
    closeFloatWindow();
    closePopupWindow();
    if (mainWindow) {
        mainWindow.webContents.send('overlay-state-changed', false);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.setAlwaysOnTop(true);
        mainWindow.show();
        mainWindow.focus();
        setTimeout(() => { if (mainWindow) mainWindow.setAlwaysOnTop(false); }, 500);
    }
    return true;
});

ipcMain.handle('onClose', () => { app.quit(); return true; });

ipcMain.handle('onSpeedChange', async (_, delta) => {
    const state = await getStatePython();
    let newSpeed = Math.max(0.05, Math.min(2.0, Math.round(((state.speed || 1.0) + delta * 0.05) / 0.05) * 0.05));
    await setSpeedPython(newSpeed);
    return true;
});

ipcMain.handle('onSetSpeed', async (_, speed) => {
    let newSpeed = Math.max(0.05, Math.min(2.0, Math.round(speed / 0.05) * 0.05));
    await setSpeedPython(newSpeed);
    return true;
});

ipcMain.handle('getSpeed', async () => (await getStatePython()).speed || 1.0);
ipcMain.handle('onSeek', async (_, r) => { await seekMidiPython(r); return true; });
ipcMain.handle('onSelectItem', async (_, id) => { if (player.isPlaying) await stopMidiPython(); return loadItem(id); });

ipcMain.handle('onDeleteItem', (_, id) => {
    player.playlist = player.playlist.filter(i => i.id !== id);
    if (player.currentId === id) {
        player.currentId = null;
        stopMidiPython();
        broadcast('set-title', '未选择乐曲', '');
        broadcast('play-state-changed', false);
    }
    savePlaylist();
    updatePlaylistUI(player.playlist, player.currentId);
    return true;
});

ipcMain.handle('onDeletePopupItem', (_, id) => {
    player.playlist = player.playlist.filter(i => i.id !== id);
    if (player.currentId === id) {
        player.currentId = null;
        stopMidiPython();
        broadcast('set-title', '未选择乐曲', '');
        broadcast('play-state-changed', false);
    }
    savePlaylist();
    updatePlaylistUI(player.playlist, player.currentId);
    return true;
});

ipcMain.handle('onPopupClose', () => { closePopupWindow(); return true; });
ipcMain.handle('onDetectWindow', () => {
    if (floatWindow) floatWindow.webContents.send('detect-countdown-start', 5);
    startDetectCountdown();
    return true;
});

ipcMain.handle('onSaveImage', async (_, src) => {
    try {
        const imgPath = path.join(__dirname, 'renderer', src);
        if (!fs.existsSync(imgPath)) return { success: false };
        const dlDir = app.getPath('downloads');
        const ext = path.extname(imgPath);
        const destName = path.basename(imgPath, ext) + ext;
        let destPath = path.join(dlDir, destName);
        let count = 1;
        while (fs.existsSync(destPath)) { destPath = path.join(dlDir, `${path.basename(imgPath, ext)}_${count}${ext}`); count++; }
        fs.copyFileSync(imgPath, destPath);
        fs.utimesSync(destPath, new Date(), new Date());
        return { success: true, name: path.basename(destPath) };
    } catch (e) { return { success: false }; }
});