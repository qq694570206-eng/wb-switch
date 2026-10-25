/**
 * Electron 主进程。
 *
 * 只做三件事：
 *  1. 创建窗口并加载界面
 *  2. 把 IPC 请求转发给 src/gui/service.ts
 *  3. 提供文件对话框 / 打开目录等系统能力
 *
 * 所有业务逻辑都在 service.ts，主进程保持薄壳，便于单独测试。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { WbError } from '../errors.js';
import {
  composeModelsFromRemote,
  composeModelsFromTemplate,
  createFromCurrent,
  createManual,
  exportProfile,
  fetchRemoteModels,
  getOverview,
  getProfile,
  getRoot,
  importProfile,
  listBackups,
  listTemplates,
  removeProfile,
  renameProfileTo,
  restoreBackup,
  runDoctor,
  saveProfileModels,
  startProtocolProxy,
  stopProtocolProxy,
  getProxyStatus,
  getProxiedModelsJson,
  suggestConnection,
  switchProfile,
  type ComposeModelsInput,
  type ConnectionSuggestion,
  type DoctorReport,
  type ManualProfileInput,
  type ModelView,
  type Overview,
  type ProfileDetail,
  type SwitchReport,
} from './service.js';
import type { VendorTemplate } from './templates.js';
import { listProfileNames } from '../profiles.js';
import { readState } from '../state.js';

const APP_VERSION = app.getVersion();

interface Ok<T> {
  ok: true;
  data: T;
}
interface Err {
  ok: false;
  error: string;
  hint?: string;
  code?: number;
}
type Reply<T> = Ok<T> | Err;

function handle<T>(fn: () => T): Reply<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    const e = err as WbError;
    return {
      ok: false,
      error: e?.message ? e.message : String(err),
      hint: e?.hint,
      code: e?.code,
    };
  }
}

async function handleAsync<T>(fn: () => Promise<T>): Promise<Reply<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const e = err as WbError;
    return {
      ok: false,
      error: e?.message ? e.message : String(err),
      hint: e?.hint,
      code: e?.code,
    };
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'wb-switch',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 开发辅助：设置 WB_GUI_SHOT=<png 路径> 时截图后自动退出，用于界面回归。
  // 可选 WB_GUI_SCRIPT 在截图前注入一段 JS（点击按钮、切换页面等）。
  const shotPath = process.env.WB_GUI_SHOT;
  if (shotPath) {
    mainWindow.webContents.on('console-message', (...args: unknown[]) => {
      const detail = args[1];
      const text =
        detail && typeof detail === 'object' && 'message' in detail
          ? String((detail as { message: unknown }).message)
          : String(args[2] ?? '');
      if (text) console.log('[renderer]', text);
    });

    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const script = process.env.WB_GUI_SCRIPT;
          if (script) {
            // 包成 async IIFE，脚本里就能用 await 等待 IPC 往返
            await mainWindow!.webContents.executeJavaScript(`(async () => {${script}})()`, true);
            await new Promise((r) => setTimeout(r, 800));
          }
          const img = await mainWindow!.webContents.capturePage();
          fs.writeFileSync(shotPath, img.toPNG());
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('截图失败：', err);
        } finally {
          app.exit(0);
        }
      }, 1500);
    });
  }

  // 关闭窗口时最小化到托盘而不是退出（除非托盘已被销毁或用户从托盘点退出）
  mainWindow.on('close', (e) => {
    if (!tray || tray.isDestroyed()) return;
    e.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器，绝不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu(): void {
  // 保留最小菜单：编辑类快捷键（复制/粘贴/全选）依赖菜单角色才能在 Windows 上稳定生效
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '重新加载界面',
          accelerator: 'F5',
          click: () => mainWindow?.reload(),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────── 系统托盘 ───────────────────────────

let tray: Tray | null = null;

function buildTray(): void {
  const iconPath = path.join(__dirname, 'icon.ico');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('wb-switch · WorkBuddy 模型源切换');

  // 托盘菜单：显示窗口 + 源列表（点击切源）+ 退出
  function refreshTrayMenu(): void {
    if (!tray) return;
    const root = getRoot();
    const names = (() => {
      try {
        return listProfileNames(root).map((n) => {
          const state = readState(root);
          const isActive = state.active?.toLowerCase() === n.toLowerCase();
          return { name: n, active: isActive };
        });
      } catch {
        return [];
      }
    })();

    const items: Electron.MenuItemConstructorOptions[] = [
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
    ];

    if (names.length) {
      for (const p of names) {
        items.push({
          label: `${p.active ? '● ' : '  '}${p.name}`,
          click: () => {
            try {
              switchProfile(p.name);
              showMainWindow();
              mainWindow?.webContents.send('wb:tray-switched', p.name);
            } catch {
              /* 忽略切换失败 */
            }
          },
        });
      }
      items.push({ type: 'separator' });
    }

    items.push({ label: '退出', click: () => app.quit() });

    tray!.setContextMenu(Menu.buildFromTemplate(items));
  }

  // 双击托盘图标显示窗口
  tray.on('double-click', () => showMainWindow());

  // 初始构建菜单，之后每次切换/增删源后刷新
  refreshTrayMenu();

  // 监听渲染进程的刷新请求
  ipcMain.on('wb:refreshTray', () => refreshTrayMenu());
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// ─────────────────────────── IPC ───────────────────────────

function registerIpc(): void {
  ipcMain.handle('wb:overview', (): Reply<Overview> => handle(() => getOverview(APP_VERSION)));

  ipcMain.handle('wb:profile', (_e, name: string): Reply<ProfileDetail> =>
    handle(() => getProfile(name)),
  );

  ipcMain.handle('wb:switch', (_e, name: string, force?: boolean): Reply<SwitchReport> =>
    handle(() => switchProfile(name, force === true)),
  );

  ipcMain.handle(
    'wb:createFromCurrent',
    (_e, name: string, description?: string) => handle(() => createFromCurrent(name, description)),
  );

  ipcMain.handle('wb:createManual', (_e, input: ManualProfileInput) =>
    handle(() => createManual(input)),
  );

  ipcMain.handle(
    'wb:saveModels',
    (_e, name: string, models: ModelView[], description?: string) =>
      handle(() => saveProfileModels(name, models, description)),
  );

  ipcMain.handle('wb:remove', (_e, name: string) => handle(() => removeProfile(name)));

  ipcMain.handle('wb:rename', (_e, from: string, to: string) =>
    handle(() => renameProfileTo(from, to)),
  );

  ipcMain.handle('wb:backups', () => handle(() => listBackups()));

  ipcMain.handle('wb:restore', (_e, file: string) => handle(() => restoreBackup(file)));

  ipcMain.handle('wb:doctor', (): Reply<DoctorReport> => handle(() => runDoctor()));

  // 从网关拉模型列表（「新建源」用）
  ipcMain.handle(
    'wb:fetchModels',
    (_e, input: { url: string; apiKey: string; timeoutMs?: number; proxyUrl?: string }) =>
      handleAsync(() => fetchRemoteModels(input)),
  );

  ipcMain.handle('wb:suggestConnection', (_e, profileName?: string): Reply<ConnectionSuggestion | null> =>
    handle(() => suggestConnection(profileName)),
  );

  ipcMain.handle('wb:composeModels', (_e, input: ComposeModelsInput): Reply<ModelView[]> =>
    handle(() => composeModelsFromRemote(input)),
  );

  // 模板列表 + 从模板组装模型
  ipcMain.handle('wb:templates', (): Reply<VendorTemplate[]> =>
    handle(() => listTemplates()),
  );

  ipcMain.handle(
    'wb:composeFromTemplate',
    (_e, templateId: string, apiKey: string, selectedIds: string[]): Reply<ModelView[]> =>
      handle(() => composeModelsFromTemplate(templateId, apiKey, selectedIds)),
  );

  // ── 协议转换代理 ──
  ipcMain.handle('wb:proxyStart', async (_e, proxyUrl?: string) =>
    handleAsync(async () => startProtocolProxy(proxyUrl)),
  );

  ipcMain.handle('wb:proxyStop', () => handle(() => { stopProtocolProxy(); return null; }));

  ipcMain.handle('wb:proxyStatus', () => handle(() => getProxyStatus()));

  ipcMain.handle('wb:proxyModels', (_e, proxyBaseUrl: string) =>
    handle(() => getProxiedModelsJson(proxyBaseUrl)),
  );

  ipcMain.handle('wb:export', async (_e, name: string) =>
    handleAsync(async () => {
      if (!mainWindow) throw new Error('窗口不可用');
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '导出源配置',
        defaultPath: `${name}-models.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return null;
      return exportProfile(name, res.filePath);
    }),
  );

  // 批量导出：选文件夹
  ipcMain.handle('wb:pickExportDir', async () =>
    handleAsync(async () => {
      if (!mainWindow) throw new Error('窗口不可用');
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择导出文件夹',
        properties: ['openDirectory'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0]!;
    }),
  );

  ipcMain.handle('wb:exportProfileTo', async (_e, name: string, dir: string) =>
    handleAsync(async () => {
      const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
      const dest = path.join(dir, `${safeName}-models.json`);
      return exportProfile(name, dest);
    }),
  );

  ipcMain.handle('wb:import', async () =>
    handleAsync(async () => {
      if (!mainWindow) throw new Error('窗口不可用');
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择要导入的 models.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0]!;
    }),
  );

  ipcMain.handle('wb:importAs', (_e, file: string, name: string) =>
    handle(() => importProfile(file, name)),
  );

  // 拖拽导入：渲染进程传 JSON 字符串，主进程写临时文件再导入
  ipcMain.handle('wb:importJson', async (_e, jsonStr: string, name: string) => {
    return handleAsync(async () => {
      const tmp = path.join(app.getPath('temp'), `wb-import-${Date.now()}.json`);
      fs.writeFileSync(tmp, jsonStr, 'utf8');
      const result = importProfile(tmp, name);
      try { fs.unlinkSync(tmp); } catch { /* 临时文件不删也无所谓 */ }
      return result;
    });
  });

  ipcMain.handle('wb:reveal', async (_e, p?: string) =>
    handleAsync(async () => {
      const target = p || getRoot();
      const err = await shell.openPath(target);
      if (err) throw new Error(err);
      return target;
    }),
  );

  ipcMain.handle('wb:copy', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true, data: true };
  });
}

// ─────────────────────────── 生命周期 ───────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.wbswitch.app');
    buildMenu();
    registerIpc();
    buildTray();
    createWindow();

    app.on('activate', () => {
      showMainWindow();
    });
  });

  // 有关闭托盘后，关窗口=真退出
  app.on('window-all-closed', () => {
    if (tray && !tray.isDestroyed()) return; // 有托盘就不退出
    app.quit();
  });
}
