/* 桌面壳：起 Python 后端 → 等端口就绪 → 用窗口加载现有编辑器页面。
   业务代码一律在 editor/ 里，这里只负责进程与窗口生命周期。 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 某些环境（CI、被包了一层的 shell）会带着 ELECTRON_RUN_AS_NODE=1，
// 那样二进制退化成纯 Node，app 是 undefined（process.versions.electron 还在，
// 所以两个都要看）。这里先挡一下，给个能看懂的提示。
if (!app || !process.versions.electron) {
  console.error('Electron 没有以 GUI 模式启动（ELECTRON_RUN_AS_NODE 可能被设成了 1）。\n' +
                '请在普通终端里运行 npm run editor，或先执行 set ELECTRON_RUN_AS_NODE= 再启动。');
  process.exit(1);
}

const PORT = Number(process.env.LC_EDITOR_PORT || 8765);
const ROOT = path.resolve(__dirname, '..', '..');   // live-archive 根目录
let py = null;

// 后端固定用仓库里的 .venv：导出脚本（export.py 等）由 server.py 用
// sys.executable 再拉起，这样重建时的依赖和手跑 python 完全一致。
// 没建 venv 就退回 PATH 上的 python，装依赖前也能先用。
function pythonRun() {
  const win = process.platform === 'win32';
  const venv = path.join(ROOT, '.venv');
  const exe = path.join(venv, win ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(exe)) {
    const bin = path.dirname(exe);
    return {
      cmd: exe,
      env: Object.assign({}, process.env, {
        VIRTUAL_ENV: venv,
        PATH: bin + path.delimiter + (process.env.PATH || ''),
      }),
    };
  }
  return { cmd: win ? 'python' : 'python3', env: process.env };
}

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/bootstrap', timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(tries) {
  for (let i = 0; i < tries; i++) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function startBackend() {
  const run = pythonRun();
  console.log('[py] using ' + run.cmd);
  py = spawn(run.cmd, [path.join(ROOT, 'editor', 'server.py'), String(PORT)], {
    cwd: ROOT,
    env: run.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  py.stdout.on('data', (d) => process.stdout.write('[py] ' + d));
  py.stderr.on('data', (d) => process.stderr.write('[py] ' + d));
  py.on('exit', (code) => {
    py = null;
    if (code) console.error('[py] backend exited with code', code);
  });
  py.on('error', (e) => console.error('[py] spawn failed:', e.message));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14110f',
    title: '火羽直播档案 · 编辑器',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('http://127.0.0.1:' + PORT + '/');
  // 兜底：Windows 上原生对话框 / 系统弹窗关掉后，窗口是激活的但 webContents
  // 拿不到键盘焦点（能点、打不进字）。每次窗口获得焦点都把焦点交回页面。
  win.on('focus', () => {
    if (!win.isDestroyed() && !win.webContents.isFocused()) win.webContents.focus();
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(async () => {
  // 端口已被占用时（比如先手动起过服务）直接复用，不再重复 spawn
  if (!(await probe())) startBackend();
  if (!(await waitReady(60))) {
    dialog.showErrorBox(
      '启动失败',
      'Python 后端没有就绪（端口 ' + PORT + '）。\n' +
      '先确认 ' + path.join(ROOT, '.venv') + ' 里的 python 能跑，或手动执行 python editor/server.py 看看报什么错。'
    );
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (py) {
    try { py.kill(); } catch (e) { /* 已退出 */ }
    py = null;
  }
});
