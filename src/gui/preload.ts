/**
 * 预加载脚本：用 contextBridge 暴露一组受限的 API。
 * 渲染进程拿不到 Node，也无法直接 require，所有能力都必须经过这里。
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface Reply<T> {
  ok: boolean;
  data?: T;
  error?: string;
  hint?: string;
  code?: number;
}

const api = {
  overview: () => ipcRenderer.invoke('wb:overview'),
  profile: (name: string) => ipcRenderer.invoke('wb:profile', name),
  switchTo: (name: string, force = false) => ipcRenderer.invoke('wb:switch', name, force),
  createFromCurrent: (name: string, description?: string) =>
    ipcRenderer.invoke('wb:createFromCurrent', name, description),
  createManual: (input: unknown) => ipcRenderer.invoke('wb:createManual', input),
  saveModels: (name: string, models: unknown[], description?: string) =>
    ipcRenderer.invoke('wb:saveModels', name, models, description),
  remove: (name: string) => ipcRenderer.invoke('wb:remove', name),
  rename: (from: string, to: string) => ipcRenderer.invoke('wb:rename', from, to),
  backups: () => ipcRenderer.invoke('wb:backups'),
  restore: (file: string) => ipcRenderer.invoke('wb:restore', file),
  doctor: () => ipcRenderer.invoke('wb:doctor'),
  fetchModels: (input: { url: string; apiKey: string; timeoutMs?: number; proxyUrl?: string }) =>
    ipcRenderer.invoke('wb:fetchModels', input),
  suggestConnection: (profileName?: string) =>
    ipcRenderer.invoke('wb:suggestConnection', profileName),
  composeModels: (input: unknown) => ipcRenderer.invoke('wb:composeModels', input),
  templates: () => ipcRenderer.invoke('wb:templates'),
  composeFromTemplate: (templateId: string, apiKey: string, selectedIds: string[]) =>
    ipcRenderer.invoke('wb:composeFromTemplate', templateId, apiKey, selectedIds),
  proxyStart: (proxyUrl?: string) => ipcRenderer.invoke('wb:proxyStart', proxyUrl),
  proxyStop: () => ipcRenderer.invoke('wb:proxyStop'),
  proxyStatus: () => ipcRenderer.invoke('wb:proxyStatus'),
  proxyModels: (proxyBaseUrl: string) => ipcRenderer.invoke('wb:proxyModels', proxyBaseUrl),
  exportProfile: (name: string) => ipcRenderer.invoke('wb:export', name),
  pickExportDir: () => ipcRenderer.invoke('wb:pickExportDir'),
  exportProfileTo: (name: string, dir: string) => ipcRenderer.invoke('wb:exportProfileTo', name, dir),
  pickImportFile: () => ipcRenderer.invoke('wb:import'),
  importAs: (file: string, name: string) => ipcRenderer.invoke('wb:importAs', file, name),
  importJson: (jsonStr: string, name: string) => ipcRenderer.invoke('wb:importJson', jsonStr, name),
  reveal: (p?: string) => ipcRenderer.invoke('wb:reveal', p),
  copy: (text: string) => ipcRenderer.invoke('wb:copy', text),
  onTraySwitched: (cb: (name: string) => void) => {
    ipcRenderer.on('wb:tray-switched', (_e, name: string) => cb(name));
  },
  refreshTray: () => ipcRenderer.send('wb:refreshTray'),
};

export type WbApi = typeof api;

contextBridge.exposeInMainWorld('wb', api);
