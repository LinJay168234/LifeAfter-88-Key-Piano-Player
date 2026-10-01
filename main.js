const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const pianoKeys = require('./pianoKeys');

// ============================================================
// Python 命令探测
// ============================================================
function getPythonCmd() {
    const candidates = ['python', 'python3', 'py'];
    for (const cmd of candidates) {
        try {
            execSync(`${cmd} --version`, { stdio: 'ignore' });
            console.log(`[Main] 使用 Python 命令: ${cmd}`);
            return cmd;
        } catch (e) {}
    }
    console.error('[Main] Python 未安装');
    return null;
}

// ============================================================
// Python MIDI 控制器 - 常驻进程
// 打包后优先用 midi_controller.exe，开发环境用 python midi_controller.py
// ============================================================
let PYTHON_CMD = null;
let PYTHON_CONTROLLER = null;
let USE_EXE = false;

if (app.isPackaged) {
    const exePath = path.join(process.resourcesPath, 'midi_controller.exe');
    const pyPath = path.join(process.resourcesPath, 'midi_controller.py');
    if (fs.existsSync(exePath)) {
        PYTHON_CONTROLLER = exePath;
        USE_EXE = true;
        console.log('[Main] 使用打包的 midi_controller.exe:', exePath);
    } else if (fs.existsSync(pyPath)) {
        PYTHON_CONTROLLER = pyPath;
        PYTHON_CMD = getPythonCmd();
        console.log('[Main] 使用 Python 脚本:', pyPath);
    } else {
        console.error('[Main] 找不到 midi_controller.exe 或 midi_controller.py');
    }
} else {
    PYTHON_CONTROLLER = path.join(__dirname, 'midi_controller.py');
    PYTHON_CMD = getPythonCmd();
    console.log('[Main] 开发环境 Python 命令:', PYTHON_CMD);
}

// ============================================================
// Python 常驻进程管理
// ============================================================

let pythonProc = null;
let pythonReady = false;
let pendingRequests = new Map();
let requestId = 0;

function startPythonService() {
    if (pythonProc) {
        try { pythonProc.kill(); } catch(e) {}
        pythonProc = null;
    }
    
    if (USE_EXE) {
        if (!PYTHON_CONTROLLER || !fs.existsSync(PYTHON_CONTROLLER)) {
            console.error('[Main] midi_controller.exe 不存在');
            return;
        }
        console.log('[Main] 启动 midi_controller.exe...');
        pythonProc = spawn(PYTHON_CONTROLLER, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
    } else {
        if (!PYTHON_CMD || !PYTHON_CONTROLLER || !fs.existsSync(PYTHON_CONTROLLER)) {
            console.error('[Main] Python 不可用');
            return;
        }
        console.log('[Main] 启动 Python 常驻服务...');
        pythonProc = spawn(PYTHON_CMD, [PYTHON_CONTROLLER], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
    }
    
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
                console.error('[Main] Python 响应解析失败:', trimmed);
            }
        }
    });
    
    pythonProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.log('[Python stderr]', msg);
    });
    
    pythonProc.on('close', (code) => {
        console.log('[Main] Python 服务已退出, code:', code);
        pythonProc = null;
        pythonReady = false;
        for (const [id, { resolve, timeout }] of pendingRequests) {
            clearTimeout(timeout);
            resolve({ error: 'Python 服务已退出' });
        }
        pendingRequests.clear();
    });
    
    pythonProc.on('error', (err) => {
        console.error('[Main] Python 进程错误:', err);
    });
    
    pythonReady = true;
}

function callPython(command, data = {}, timeoutMs = 15000) {
    return new Promise((resolve) => {
        if (!pythonProc || !pythonReady) {
            startPythonService();
            if (!pythonProc) {
                resolve({ error: 'Python 服务不可用' });
                return;
            }
        }
        
        const id = ++requestId;
        const inputData = { command, ...data };
        const jsonInput = Buffer.from(JSON.stringify(inputData) + '\n', 'utf8');
        
        const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                resolve({ error: '超时' });
            }
        }, timeoutMs);
        
        pendingRequests.set(id, { resolve, timeout });
        
        try {
            pythonProc.stdin.write(jsonInput);
        } catch (e) {
            clearTimeout(timeout);
            pendingRequests.delete(id);
            resolve({ error: '写入失败: ' + e.message });
        }
    });
}

// ============================================================
app.setName('MIDI钢琴播放器');
Menu.setApplicationMenu(null);

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');

let mainWindow = null;
let floatWindow = null;
let popupWindow = null;
let isFloatWindowVisible = false;
let globalShortcutRegistered = false;

const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return { themeColor: '#FF8800', folderPath: '' }; }
}
function saveSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); }

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
let playbackEndHandled = false;
let cachedTracks = [];

let targetWindowInfo = {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    title: '',
    locked: false,
    hwnd: null,
};

let midiLoaded = false;

// ============================================================
// 窗口锁定检查
// ============================================================

function isWindowLocked() {
    return !!(targetWindowInfo && targetWindowInfo.locked === true);
}

// 副标题辅助文本（单行，用全角空格分隔）
const HINT_PLAY = '空格键 播放，双击重置';
const HINT_PAUSE = '空格键 暂停，双击重置';

function statusLoaded() {
    if (player.currentId) {
        return '已加载　' + HINT_PLAY;
    }
    return '请导入 .mid 文件　' + HINT_PLAY;
}

// ============================================================
// Python 命令封装
// ============================================================

async function detectWindowPython() {
    const result = await callPython('detect', {}, 10000);
    console.log('[Main] 检测结果:', result);
    return result;
}

async function getWindowInfoPython() {
    const result = await callPython('info', {}, 5000);
    console.log('[Main] 窗口信息:', result);
    return result;
}

async function loadMidiPython(filePath) {
    if (!fs.existsSync(filePath)) {
        console.log('[Main] 文件不存在:', filePath);
        return { success: false, error: '文件不存在' };
    }
    
    console.log('[Main] 加载文件:', filePath);
    
    const result = await callPython('load', { filePath: filePath });
    if (result && result.success) {
        midiLoaded = true;
        if (result.totalDuration) {
            player.totalDuration = result.totalDuration;
            player.currentTime = 0;
            console.log('[Main] 总时长:', result.totalDuration, 'ms');
        }
        
        if (result.tracks) {
            cachedTracks = result.tracks;
            console.log('[Main] 轨道信息:', result.tracks);
            broadcast('update-tracks', result.tracks);
        }
    }
    console.log('[Main] 加载MIDI结果:', result);
    return result;
}

async function playMidiPython() {
    if (!isWindowLocked()) {
        console.log('[Main] 未锁定窗口，拒绝播放');
        broadcast('play-state-changed', false);
        return { success: false, error: '未锁定窗口' };
    }
    
    const result = await callPython('play');
    if (result && result.success === false) {
        broadcast('play-state-changed', false);
        return result;
    }
    player.isPlaying = true;
    playbackEndHandled = false;
    broadcast('play-state-changed', true);
    broadcast('set-status', '播放中　' + HINT_PAUSE);
    if (!progressTracker) {
        startProgressTracking();
    }
    return result;
}

async function pauseMidiPython() {
    const result = await callPython('pause');
    player.isPlaying = false;
    broadcast('play-state-changed', false);
    broadcast('set-status', '已暂停　' + HINT_PLAY);
    return result;
}

async function stopMidiPython() {
    const result = await callPython('stop');
    player.isPlaying = false;
    player.currentTime = 0;
    playbackEndHandled = false;
    broadcast('play-state-changed', false);
    broadcast('progress-update', { currentMs: 0, totalMs: player.totalDuration });
    broadcast('set-status', statusLoaded());
    if (progressTracker) {
        clearInterval(progressTracker);
        progressTracker = null;
    }
    return result;
}

async function seekMidiPython(ratio) {
    return await callPython('seek', { ratio });
}

async function setSpeedPython(speed) {
    const result = await callPython('speed', { speed });
    player.speed = speed;
    broadcast('speed-changed', speed);
    return result;
}

async function getStatePython() {
    const result = await callPython('state');
    if (result && result.totalDuration !== undefined) {
        player.currentTime = result.currentTime || 0;
        if (result.totalDuration > 0) {
            player.totalDuration = result.totalDuration;
        }
        broadcast('progress-update', { currentMs: player.currentTime, totalMs: player.totalDuration });
    }
    return result;
}

async function getTracksPython() {
    const result = await callPython('tracks');
    return result;
}

async function toggleTrackPython(index) {
    const result = await callPython('toggle_track', { index });
    return result;
}

async function resetPython() {
    const result = await callPython('reset');
    targetWindowInfo.locked = false;
    cachedTracks = [];
    return result;
}

// ============================================================
// 进度追踪
// ============================================================

function startProgressTracking() {
    if (progressTracker) {
        clearInterval(progressTracker);
        progressTracker = null;
    }
    playbackEndHandled = false;
    progressTracker = setInterval(async () => {
        const state = await getStatePython();
        if (state && state.isPlaying === false && !playbackEndHandled) {
            if (player.isPlaying) {
                playbackEndHandled = true;
                player.isPlaying = false;
                player.currentTime = 0;

                await callPython('stop');

                broadcast('play-state-changed', false);
                broadcast('set-status', '已加载　' + HINT_PLAY);
                broadcast('progress-update', { currentMs: 0, totalMs: player.totalDuration });

                if (progressTracker) {
                    clearInterval(progressTracker);
                    progressTracker = null;
                }
            }
        }
    }, 500);
}

// ============================================================
// 窗口检测 - 倒计时交给 UI，主进程只负责到点后检测
// ============================================================

async function startDetectCountdown() {
    if (detectCountdown) {
        clearInterval(detectCountdown);
        detectCountdown = null;
    }
    
    let countdown = 5;
    
    detectCountdown = setInterval(async () => {
        countdown--;
        if (countdown > 0) return;
        
        clearInterval(detectCountdown);
        detectCountdown = null;
        
        console.log('[Main] 倒计时结束，开始检测窗口');
        
        const detectResult = await detectWindowPython();
        
        if (detectResult && detectResult.success) {
            targetWindowInfo.title = detectResult.title;
            targetWindowInfo.locked = true;
            targetWindowInfo.hwnd = null;
            
            broadcast('set-status', '已暂停　' + HINT_PLAY);
            
            const info = await getWindowInfoPython();
            
            if (info && info.available) {
                targetWindowInfo.x = info.rect[0];
                targetWindowInfo.y = info.rect[1];
                targetWindowInfo.width = info.width;
                targetWindowInfo.height = info.height;
                targetWindowInfo.title = info.title;
                targetWindowInfo.hwnd = info.hwnd || null;
                targetWindowInfo.locked = true;
                
                broadcast('detect-result', { locked: true, hint: '已锁定: ' + info.title });
                
                if (floatWindow && !floatWindow.isDestroyed()) {
                    floatWindow.webContents.executeJavaScript(`
                        const b = document.getElementById('btn-detect-window');
                        if (b) b.classList.add('locked');
                    `).catch(() => {});
                }
            } else {
                targetWindowInfo.locked = true;
                broadcast('detect-result', { locked: true, hint: '已锁定: ' + detectResult.title });
                
                if (floatWindow && !floatWindow.isDestroyed()) {
                    floatWindow.webContents.executeJavaScript(`
                        const b = document.getElementById('btn-detect-window');
                        if (b) b.classList.add('locked');
                    `).catch(() => {});
                }
            }
        } else {
            targetWindowInfo.locked = false;
            broadcast('detect-result', { locked: false, hint: '未检测到窗口' });
            if (floatWindow && !floatWindow.isDestroyed()) {
                floatWindow.webContents.executeJavaScript(`
                    const b = document.getElementById('btn-detect-window');
                    if (b) b.classList.remove('locked');
                `).catch(() => {});
            }
        }
    }, 1000);
}

// ============================================================
// 广播和UI更新
// ============================================================

function broadcast(channel, ...args) {
    const windows = [mainWindow, floatWindow, popupWindow].filter(w => w && !w.isDestroyed());
    windows.forEach(win => {
        try { win.webContents.send(channel, ...args); } catch (e) {}
    });
}

function refreshMainPlaylist(list, currentId) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`
            if (window.PianoUI && window.PianoUI.setPlaylist) {
                window.PianoUI.setPlaylist(${JSON.stringify(list || [])}, ${JSON.stringify(currentId || null)});
            }
        `).catch(() => {});
    }
}

function updatePlaylistUI(list, currentId) {
    broadcast('update-playlist', list, currentId);
    refreshMainPlaylist(list, currentId);
    if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.webContents.executeJavaScript(`
            if (window.PianoUI && window.PianoUI.setPopupList) {
                window.PianoUI.setPopupList(${JSON.stringify(list)}, ${JSON.stringify(currentId)});
            }
        `).catch(() => {});
    }
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
    if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.webContents.executeJavaScript(`
            if (window.PianoUI && window.PianoUI.setProgress) {
                window.PianoUI.setProgress(${currentMs || 0}, ${totalMs || 120000});
            }
        `).catch(() => {});
    }
}

function syncTracks(tracks) {
    cachedTracks = tracks || [];
    broadcast('update-tracks', cachedTracks);
}

function loadItem(id) {
    const item = player.playlist.find(i => i.id === id);
    if (!item) return false;
    
    if (player.isPlaying) {
        callPython('stop');
        player.isPlaying = false;
    }
    
    player.currentId = id;
    player.currentTime = 0;
    player.totalDuration = 0;
    
    broadcast('set-title', item.name, '');
    updatePlaylistUI(player.playlist, id);
    savePlaylist();
    
    loadMidiPython(item.filePath).then((result) => {
        if (result && result.success) {
            player.totalDuration = result.totalDuration || 120000;
            player.currentTime = 0;
            syncProgress(0, player.totalDuration);
            broadcast('play-state-changed', false);
            broadcast('set-status', '已加载　' + HINT_PLAY);
        } else {
            broadcast('set-status', statusLoaded());
            syncProgress(0, 0);
        }
    });
    return true;
}

function playItem(id) {
    const item = player.playlist.find(i => i.id === id);
    if (!item) return;
    
    if (player.isPlaying) {
        callPython('stop');
        player.isPlaying = false;
    }
    
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
            setTimeout(() => {
                playMidiPython();
            }, 200);
        } else {
            broadcast('set-status', statusLoaded());
        }
    });
}

// ============================================================
// 创建窗口函数
// ============================================================

function createFloatWindow() {
    if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.focus();
        return floatWindow;
    }
    try {
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        const winX = Math.round((width - 420) / 2);
        const winY = Math.round((height - 520) / 2);
        const win = new BrowserWindow({
            width: 420,
            height: 520,
            x: winX,
            y: winY,
            alwaysOnTop: true,
            transparent: true,
            frame: false,
            resizable: false,
            skipTaskbar: true,
            hasShadow: false,
            backgroundColor: '#00000000',
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                zoomFactor: 1.38,
            },
        });
        const color = loadSettings().themeColor || '#FF8800';
        win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'), {
            query: { view: 'float', theme: color }
        });
        win.webContents.on('did-finish-load', async () => {
            win.webContents.insertCSS(`
                .grabber { -webkit-app-region: drag; }
                .grabber-bar, .grabber-text { pointer-events: none; }
                html, body { background: transparent !important; margin: 0; padding: 0; }
                .float-root { margin: 0; }
            `);
            win.webContents.send('set-float-mode', true);
            
            let tracks = cachedTracks;
            if (!tracks || tracks.length === 0) {
                try {
                    const tracksResult = await callPython('tracks');
                    if (tracksResult && tracksResult.tracks) {
                        tracks = tracksResult.tracks;
                        cachedTracks = tracks;
                    }
                } catch (e) {
                    console.error('[Main] 获取轨道信息失败:', e);
                }
            }
            
            win.webContents.executeJavaScript(`
                (function() {
                    const params = new URLSearchParams(location.search);
                    const themeColor = params.get('theme') || '#FF8800';
                    if (typeof applyAccent === 'function') {
                        applyAccent(themeColor);
                    }
                    const grabber = document.getElementById('float-drag');
                    if (grabber) {
                        grabber.style.webkitAppRegion = 'drag';
                    }
                    if (window.PianoUI && window.PianoUI.setPlaylist) {
                        window.PianoUI.setPlaylist(${JSON.stringify(player.playlist)}, ${JSON.stringify(player.currentId)});
                    }
                    const currentItem = ${JSON.stringify(player.playlist.find(i => i.id === player.currentId))};
                    if (currentItem && window.PianoUI && window.PianoUI.setTitle) {
                        window.PianoUI.setTitle(currentItem.name, '');
                    } else if (window.PianoUI && window.PianoUI.setTitle) {
                        window.PianoUI.setTitle('未选择乐曲', '');
                    }
                    if (window.PianoUI && window.PianoUI.setTracks) {
                        window.PianoUI.setTracks(${JSON.stringify(tracks || [])});
                    }
                    if (window.PianoUI && window.PianoUI.setProgress) {
                        window.PianoUI.setProgress(${player.currentTime || 0}, ${player.totalDuration || 120000});
                    }
                    if (window.PianoUI && window.PianoUI.setPlaying) {
                        window.PianoUI.setPlaying(${player.isPlaying});
                    }
                    if (window.PianoUI && window.PianoUI.setStatusText) {
                        window.PianoUI.setStatusText(${JSON.stringify(statusLoaded())});
                    }
                    if (window.PianoUI && window.PianoUI.setDetectLocked) {
                        window.PianoUI.setDetectLocked(${targetWindowInfo.locked === true});
                    }
                    document.body.style.transition = 'opacity 0.15s ease';
                    document.body.style.opacity = '1';
                })();
            `).catch(() => {});
            win.show();
        });
        win.on('closed', () => {
            floatWindow = null;
            isFloatWindowVisible = false;
            unregisterGlobalShortcut();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('overlay-state-changed', false);
            }
        });
        win.on('show', () => {
            isFloatWindowVisible = true;
            registerGlobalShortcut();
        });
        win.on('hide', () => {
            isFloatWindowVisible = false;
            unregisterGlobalShortcut();
        });
        floatWindow = win;
        isFloatWindowVisible = true;
        registerGlobalShortcut();
        return win;
    } catch (err) {
        console.error('[Main] 创建悬浮窗失败:', err);
        return null;
    }
}

function closeFloatWindow() {
    if (floatWindow && !floatWindow.isDestroyed()) {
        unregisterGlobalShortcut();
        floatWindow.close();
        floatWindow = null;
        isFloatWindowVisible = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('overlay-state-changed', false);
        }
    }
}

function createPopupWindow() {
    if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.focus();
        return popupWindow;
    }
    try {
        const pos = getPopupPosition();
        const win = new BrowserWindow({
            width: 420,
            height: 540,
            x: pos.x,
            y: pos.y,
            alwaysOnTop: true,
            transparent: true,
            frame: false,
            resizable: false,
            skipTaskbar: true,
            hasShadow: false,
            backgroundColor: '#00000000',
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                zoomFactor: 1.38,
            },
        });
        const color = loadSettings().themeColor || '#FF8800';
        win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'), {
            query: { view: 'popup', theme: color }
        });
        win.webContents.on('did-finish-load', async () => {
            win.webContents.insertCSS(`
                html, body { margin: 0; padding: 0; background: transparent !important; }
                .popup-root { margin: 0; width: 100%; height: 100%; }
            `);
            
            let tracks = cachedTracks;
            if (!tracks || tracks.length === 0) {
                try {
                    const tracksResult = await callPython('tracks');
                    if (tracksResult && tracksResult.tracks) {
                        tracks = tracksResult.tracks;
                        cachedTracks = tracks;
                    }
                } catch (e) {}
            }
            
            win.webContents.executeJavaScript(`
                (function() {
                    const params = new URLSearchParams(location.search);
                    const themeColor = params.get('theme') || '#FF8800';
                    if (typeof applyAccent === 'function') {
                        applyAccent(themeColor);
                    }
                    if (window.PianoUI && window.PianoUI.setTracks) {
                        window.PianoUI.setTracks(${JSON.stringify(tracks || [])});
                    }
                    document.body.style.transition = 'opacity 0.15s ease';
                    document.body.style.opacity = '1';
                })();
            `).catch(() => {});
            win.webContents.executeJavaScript(`
                if (window.PianoUI && window.PianoUI.setPopupList) {
                    window.PianoUI.setPopupList(${JSON.stringify(player.playlist)}, ${JSON.stringify(player.currentId)});
                }
            `);
            win.show();
        });
        win.on('blur', () => {
            setTimeout(() => {
                if (popupWindow && !popupWindow.isDestroyed()) {
                    closePopupWindow();
                }
            }, 50);
        });
        win.on('closed', () => {
            popupWindow = null;
        });
        popupWindow = win;
        return win;
    } catch (err) {
        console.error('[Main] 创建弹出窗口失败:', err);
        return null;
    }
}

function closePopupWindow() {
    if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.close();
        popupWindow = null;
    }
}

function getPopupPosition() {
    if (!floatWindow || floatWindow.isDestroyed()) {
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        return { x: Math.round((width - 420) / 2), y: Math.round((height - 540) / 2) };
    }
    const bounds = floatWindow.getBounds();
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    let x = bounds.x + bounds.width + 10;
    let y = bounds.y;
    if (x + 420 > width) {
        x = bounds.x - 420 - 10;
    }
    if (x < 0) {
        x = bounds.x;
        y = bounds.y + bounds.height + 10;
    }
    if (y + 540 > height) {
        y = bounds.y - 540 - 10;
    }
    if (y < 0) {
        x = Math.round((width - 420) / 2);
        y = Math.round((height - 540) / 2);
    }
    return { x, y };
}

function createMainWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 720,
        resizable: false,
        maximizable: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.setTitle('MIDI钢琴播放器');
    win.setFocusable(true);
    try {
        const iconPath = path.join(__dirname, 'icon.ico');
        if (fs.existsSync(iconPath)) {
            win.setIcon(iconPath);
        } else {
            const pngPath = path.join(__dirname, 'icon.png');
            if (fs.existsSync(pngPath)) {
                win.setIcon(pngPath);
            }
        }
    } catch (e) {}
    win.webContents.on('did-finish-load', () => {
        win.focus();
        win.webContents.focus();
        win.webContents.executeJavaScript(`
            document.body.style.transition = 'opacity 0.2s ease';
            document.body.style.opacity = '1';
            document.body.focus();
        `).catch(() => {});
        win.show();
    });
    win.on('focus', () => {
        win.webContents.focus();
        win.webContents.executeJavaScript('document.body.focus();').catch(() => {});
    });
    win.on('show', () => {
        win.focus();
        win.webContents.focus();
    });
    win.loadFile(path.join(__dirname, 'renderer', 'ui_preview_landscape.html'));
    win.on('close', () => {
        if (floatWindow && !floatWindow.isDestroyed()) {
            floatWindow.close();
            floatWindow = null;
        }
        if (popupWindow && !popupWindow.isDestroyed()) {
            popupWindow.close();
            popupWindow = null;
        }
        resetPython();
    });
    win.webContents.on('did-finish-load', () => {
        win.focus();
        win.webContents.focus();
        win.webContents.executeJavaScript(`
            (function() {
                const sw = document.getElementById('sw-overlay');
                if (sw) {
                    sw.checked = false;
                    const newSw = sw.cloneNode(true);
                    sw.parentNode.replaceChild(newSw, sw);
                    newSw.addEventListener('change', function() {
                        if (window.AndroidBridge && window.AndroidBridge.onOverlayToggle) {
                            window.AndroidBridge.onOverlayToggle(this.checked);
                        }
                    });
                }
                document.body.setAttribute('tabindex', '-1');
                document.body.focus();
            })();
        `).catch(() => {});
    });
    mainWindow = win;
    return win;
}

async function handleImport() {
    if (!player.folderPath || !fs.existsSync(player.folderPath)) {
        broadcast('set-status', '请先设置文件夹');
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: '请先选择 MIDI 文件夹'
        });
        if (r.canceled || !r.filePaths.length) {
            broadcast('set-status', statusLoaded());
            return false;
        }
        player.folderPath = r.filePaths[0];
        try {
            const files = fs.readdirSync(player.folderPath).filter(f => /\.(mid|midi)$/i.test(f));
            const newList = files.map((f, idx) => ({
                id: Date.now() + '_' + idx,
                name: f,
                filePath: path.join(player.folderPath, f),
            }));
            player.playlist = player.playlist.concat(newList);
            savePlaylist();
            updatePlaylistUI(player.playlist, player.currentId);
            broadcast('set-status', statusLoaded());
        } catch (err) {
            broadcast('set-status', statusLoaded());
            return false;
        }
    }
    const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'MIDI 文件', extensions: ['mid', 'midi'] }],
        defaultPath: player.folderPath,
    });
    if (!r.canceled && r.filePaths.length) {
        const filePath = r.filePaths[0];
        const name = path.basename(filePath);
        const newItem = {
            id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            name: name,
            filePath: filePath,
        };
        player.playlist.push(newItem);
        savePlaylist();
        updatePlaylistUI(player.playlist, player.currentId);
        
        player.currentTime = 0;
        player.totalDuration = 0;
        player.currentId = newItem.id;
        
        const result = await loadMidiPython(filePath);
        if (result && result.success) {
            player.totalDuration = result.totalDuration || 120000;
            syncProgress(0, player.totalDuration);
            broadcast('set-title', name, '');
            broadcast('play-state-changed', false);
            broadcast('set-status', '已加载　' + HINT_PLAY);
        } else {
            broadcast('set-status', statusLoaded());
        }
        return true;
    }
    return false;
}

// ============================================================
// 全局快捷键
// ============================================================
let globalKeyState = { space: false };
let globalKeyTimer = null;

function clearGlobalTimer() {
    if (globalKeyTimer) {
        clearTimeout(globalKeyTimer);
        globalKeyTimer = null;
    }
}

function resetGlobalKeyState() {
    clearGlobalTimer();
    globalKeyState.space = false;
}

function doGlobalPlayPause() {
    if (!isFloatWindowVisible) return;
    
    getStatePython().then(state => {
        if (state && state.isPlaying) {
            pauseMidiPython();
        } else {
            if (!isWindowLocked()) {
                console.log('[Main] 未锁定窗口，拒绝播放');
                broadcast('play-state-changed', false);
                return;
            }
            if (player.totalDuration > 0) {
                playMidiPython();
            } else {
                if (player.currentId) {
                    const item = player.playlist.find(i => i.id === player.currentId);
                    if (item) {
                        loadMidiPython(item.filePath).then((result) => {
                            if (result && result.totalDuration) {
                                player.totalDuration = result.totalDuration;
                                syncProgress(0, result.totalDuration);
                            }
                            setTimeout(() => {
                                playMidiPython();
                            }, 200);
                        });
                    }
                } else if (player.playlist.length > 0) {
                    playItem(player.playlist[0].id);
                } else {
                    broadcast('set-status', statusLoaded());
                }
            }
        }
    });
}

function doGlobalReset() {
    if (!isFloatWindowVisible) return;
    stopMidiPython();
}

function handleGlobalKeyPress() {
    if (!isFloatWindowVisible) return;
    if (globalKeyState.space) {
        resetGlobalKeyState();
        doGlobalReset();
        return;
    }
    globalKeyState.space = true;
    clearGlobalTimer();
    globalKeyTimer = setTimeout(() => {
        if (globalKeyState.space) {
            doGlobalPlayPause();
        }
        globalKeyState.space = false;
        globalKeyTimer = null;
    }, 300);
}

function registerGlobalShortcut() {
    if (globalShortcutRegistered) return;
    const ret = globalShortcut.register('Space', () => {
        handleGlobalKeyPress();
    });
    globalShortcutRegistered = ret;
    return ret;
}

function unregisterGlobalShortcut() {
    if (globalShortcutRegistered) {
        globalShortcut.unregister('Space');
        globalShortcutRegistered = false;
        resetGlobalKeyState();
    }
}

// ============================================================
// 应用启动
// ============================================================

app.whenReady().then(() => {
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
            if (item) {
                loadMidiPython(item.filePath).then((result) => {
                    broadcast('set-title', item.name, '');
                    broadcast('play-state-changed', false);
                    if (result && result.totalDuration) {
                        player.totalDuration = result.totalDuration;
                        syncProgress(0, result.totalDuration);
                    }
                    broadcast('set-status', '已加载　' + HINT_PLAY);
                });
            } else {
                broadcast('set-status', statusLoaded());
            }
        } else {
            broadcast('set-status', statusLoaded());
        }
    }, 500);
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('window-all-closed', () => {
    if (detectCountdown) {
        clearInterval(detectCountdown);
        detectCountdown = null;
    }
    if (progressTracker) {
        clearInterval(progressTracker);
        progressTracker = null;
    }
    unregisterGlobalShortcut();
    if (pythonProc) {
        try {
            pythonProc.stdin.write(Buffer.from(JSON.stringify({ command: 'exit' }) + '\n', 'utf8'));
            setTimeout(() => { try { pythonProc.kill(); } catch(e){} }, 500);
        } catch(e) {}
        pythonProc = null;
    }
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    globalShortcutRegistered = false;
    if (pythonProc) {
        try { pythonProc.kill(); } catch(e) {}
        pythonProc = null;
    }
});

// ============================================================
// IPC 处理
// ============================================================

ipcMain.handle('getPianoKeys', () => pianoKeys.getPianoKeys());
ipcMain.handle('getPianoKey', (_, note) => pianoKeys.getPianoKey(note));
ipcMain.handle('getNoteName', (_, note) => pianoKeys.getNoteName(note));
ipcMain.handle('findKeyByScreenPos', (_, x, y) => pianoKeys.findKeyByScreenPos(x, y));
ipcMain.handle('getScaleFactors', () => pianoKeys.getScaleFactors());

ipcMain.handle('loadMidiFile', async (_, filePath) => {
    const result = await loadMidiPython(filePath);
    if (result && result.success) {
        player.totalDuration = result.totalDuration || 120000;
        broadcast('set-title', path.basename(filePath), '');
        syncProgress(0, player.totalDuration);
        broadcast('play-state-changed', false);
        broadcast('set-status', '已加载　' + HINT_PLAY);
    }
    return result;
});

ipcMain.handle('playMidi', async () => {
    if (player.isPlaying) {
        await pauseMidiPython();
    } else {
        await playMidiPython();
    }
    return true;
});

ipcMain.handle('stopMidi', async () => {
    await stopMidiPython();
    return true;
});

ipcMain.handle('seekMidi', async (_, ratio) => {
    await seekMidiPython(ratio);
    return true;
});

ipcMain.handle('setMidiSpeed', async (_, speed) => {
    await setSpeedPython(speed);
    return true;
});

ipcMain.handle('getMidiState', async () => {
    return await getStatePython();
});

ipcMain.handle('getTrackInfo', async () => {
    if (cachedTracks && cachedTracks.length > 0) {
        return cachedTracks;
    }
    const result = await getTracksPython();
    if (result && result.tracks) {
        cachedTracks = result.tracks;
        return result.tracks;
    }
    return [];
});

ipcMain.handle('toggleTrackMute', async (_, index) => {
    const result = await toggleTrackPython(index);
    if (result && result.tracks) {
        syncTracks(result.tracks);
    }
    return result.muted;
});

ipcMain.handle('onSetFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择 MIDI 文件夹'
    });
    if (!r.canceled && r.filePaths.length) {
        player.folderPath = r.filePaths[0];
        try {
            const files = fs.readdirSync(player.folderPath).filter(f => /\.(mid|midi)$/i.test(f));
            const newList = files.map((f, idx) => ({
                id: Date.now() + '_' + idx,
                name: f,
                filePath: path.join(player.folderPath, f),
            }));
            player.playlist = player.playlist.concat(newList);
            savePlaylist();
            updatePlaylistUI(player.playlist, player.currentId);
            broadcast('set-status', statusLoaded());
            return true;
        } catch (err) {
            broadcast('set-status', statusLoaded());
            return false;
        }
    }
    return false;
});

ipcMain.handle('onImport', async () => {
    return await handleImport();
});

ipcMain.handle('onPopupImport', async () => {
    return await handleImport();
});

ipcMain.handle('onThemeChanged', (_, color) => {
    const s = loadSettings();
    s.themeColor = color;
    saveSettings(s);
    broadcast('theme-changed', color);
    return true;
});

ipcMain.handle('getThemeColor', () => {
    return loadSettings().themeColor || '#FF8800';
});

ipcMain.handle('onOverlayToggle', (_, checked) => {
    if (checked) {
        createFloatWindow();
        if (popupWindow && !popupWindow.isDestroyed()) {
            closePopupWindow();
        }
    } else {
        closeFloatWindow();
        if (popupWindow && !popupWindow.isDestroyed()) {
            closePopupWindow();
        }
    }
    return true;
});

ipcMain.handle('onTogglePopup', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
        closePopupWindow();
    } else {
        createPopupWindow();
    }
    return true;
});

ipcMain.handle('onPlayPause', async () => {
    if (!isFloatWindowVisible) return false;
    const state = await getStatePython();
    if (state && state.isPlaying) {
        await pauseMidiPython();
    } else {
        if (!isWindowLocked()) {
            console.log('[Main] 未锁定窗口，拒绝播放');
            broadcast('play-state-changed', false);
            return false;
        }
        if (player.totalDuration > 0) {
            await playMidiPython();
        } else if (player.currentId) {
            const item = player.playlist.find(i => i.id === player.currentId);
            if (item) {
                const result = await loadMidiPython(item.filePath);
                if (result && result.totalDuration) {
                    player.totalDuration = result.totalDuration;
                    syncProgress(0, result.totalDuration);
                }
                setTimeout(async () => {
                    await playMidiPython();
                }, 200);
            }
        } else if (player.playlist.length > 0) {
            playItem(player.playlist[0].id);
        } else {
            broadcast('set-status', statusLoaded());
            return false;
        }
    }
    return true;
});

ipcMain.handle('onReset', async () => {
    if (!isFloatWindowVisible) return false;
    await stopMidiPython();
    return true;
});

ipcMain.handle('onMinimize', () => {
    if (floatWindow && !floatWindow.isDestroyed()) {
        closeFloatWindow();
        if (popupWindow && !popupWindow.isDestroyed()) {
            closePopupWindow();
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            // 1. 通知主页把悬浮窗开关置为未选中
            mainWindow.webContents.send('overlay-state-changed', false);
            // 2. 主页置顶、聚焦、恢复显示
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.setAlwaysOnTop(true);
            mainWindow.show();
            mainWindow.focus();
            // 3. 短暂置顶后取消置顶（避免永久置顶）
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setAlwaysOnTop(false);
                }
            }, 500);
        }
    } else {
        // 悬浮窗本来就关着，直接让主页置顶聚焦
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.setAlwaysOnTop(true);
            mainWindow.show();
            mainWindow.focus();
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setAlwaysOnTop(false);
                }
            }, 500);
        }
    }
    return true;
});

ipcMain.handle('onClose', () => {
    app.quit();
    return true;
});

ipcMain.handle('onSpeedChange', async (_, delta) => {
    const state = await getStatePython();
    let newSpeed = (state.speed || 1.0) + delta * 0.05;
    newSpeed = Math.max(0.05, Math.min(2.0, Math.round(newSpeed / 0.05) * 0.05));
    await setSpeedPython(newSpeed);
    broadcast('speed-changed', newSpeed);
    return true;
});

ipcMain.handle('onSetSpeed', async (_, speed) => {
    let newSpeed = Math.max(0.05, Math.min(2.0, speed));
    newSpeed = Math.round(newSpeed / 0.05) * 0.05;
    await setSpeedPython(newSpeed);
    broadcast('speed-changed', newSpeed);
    return true;
});

ipcMain.handle('getSpeed', async () => {
    const state = await getStatePython();
    return state.speed || 1.0;
});

ipcMain.handle('onSeek', async (_, ratio) => {
    await seekMidiPython(ratio);
    return true;
});

ipcMain.handle('onSelectItem', async (_, id) => {
    if (player.isPlaying) {
        await stopMidiPython();
    }
    return loadItem(id);
});

ipcMain.handle('onDeleteItem', (_, id) => {
    player.playlist = player.playlist.filter(item => item.id !== id);
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
    player.playlist = player.playlist.filter(item => item.id !== id);
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

ipcMain.handle('onPopupClose', () => {
    closePopupWindow();
    return true;
});

ipcMain.handle('onDetectWindow', () => {
    if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.webContents.send('detect-countdown-start', 5);
    }
    startDetectCountdown();
    return true;
});

ipcMain.handle('onSaveImage', async (_, src) => {
    try {
        let srcPath;
        if (path.isAbsolute(src)) {
            srcPath = src;
        } else {
            const tryPaths = [
                path.join(__dirname, 'renderer', src),
                path.join(__dirname, src),
                path.join(process.resourcesPath, 'app.asar', 'renderer', src),
                path.join(process.resourcesPath, 'app.asar', src),
            ];
            srcPath = tryPaths.find(p => {
                try { return fs.existsSync(p); } catch (e) { return false; }
            });
        }
        
        if (!srcPath || !fs.existsSync(srcPath)) {
            console.error('[Main] 找不到图片:', src);
            return { success: false, error: '找不到图片文件' };
        }
        
        const downloadsDir = app.getPath('downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        
        const ext = path.extname(srcPath);
        const baseName = path.basename(srcPath, ext);
        let destName = baseName + ext;
        let destPath = path.join(downloadsDir, destName);
        let counter = 1;
        while (fs.existsSync(destPath)) {
            destName = baseName + '_' + counter + ext;
            destPath = path.join(downloadsDir, destName);
            counter++;
        }
        
        fs.copyFileSync(srcPath, destPath);
        
        // 把目标文件的修改时间设为当前时间
        const now = new Date();
        fs.utimesSync(destPath, now, now);
        
        console.log('[Main] 图片已保存:', destPath);
        
        return { success: true, path: destPath, name: destName };
    } catch (e) {
        console.error('[Main] 保存图片失败:', e);
        return { success: false, error: e.message };
    }
});

setTimeout(() => {
    broadcast('progress-update', { currentMs: 0, totalMs: 120000 });
    broadcast('speed-changed', 1.0);
}, 500);