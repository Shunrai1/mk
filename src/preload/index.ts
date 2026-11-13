import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type FileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; canceled?: boolean; error?: string }
export type SaveResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
export type ImageSaveResult =
  | { ok: true; path: string; absolutePath: string }
  | { ok: false; error: string }
export type UpdateEvent =
  | { type: 'idle' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
export type UpdateCheckResult =
  | { ok: true; status: 'available' | 'not-available'; version?: string }
  | { ok: false; message: string }
export type Theme = 'light' | 'dark' | 'grid'

function subscribe(channel: string, cb: (...args: never[]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as never[]))
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// 仅暴露白名单 API，渲染器不直接接触 ipcRenderer / Node
const api = {
  openFile: (): Promise<FileResult> => ipcRenderer.invoke('file:open'),
  openPath: (path: string): Promise<FileResult> => ipcRenderer.invoke('file:open-path', path),
  saveFile: (path: string, content: string): Promise<SaveResult> =>
    ipcRenderer.invoke('file:save', path, content),
  saveFileAs: (content: string, defaultPath?: string): Promise<SaveResult> =>
    ipcRenderer.invoke('file:save-as', content, defaultPath),
  getInitialFile: (): Promise<FileResult | null> => ipcRenderer.invoke('file:initial'),
  savePastedImage: (data: ArrayBuffer, ext: string, docPath: string | null): Promise<ImageSaveResult> =>
    ipcRenderer.invoke('image:save', { data, ext, docPath }),
  importImageFile: (sourcePath: string, docPath: string | null): Promise<ImageSaveResult> =>
    ipcRenderer.invoke('image:import', { sourcePath, docPath }),
  setDocState: (state: { dirty: boolean; path: string | null }): void =>
    ipcRenderer.send('doc:state', state),
  forceClose: (): void => ipcRenderer.send('app:force-close'),
  newWindow: (): void => ipcRenderer.send('app:new-window'),
  setDefaultApp: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('app:set-default'),
  getDefaultState: (): Promise<boolean> => ipcRenderer.invoke('app:get-default-state'),
  onDefaultChanged: (cb: (isDefault: boolean) => void): (() => void) => subscribe('default:changed', cb),
  getTheme: (): Promise<Theme> => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: Theme): void => ipcRenderer.send('theme:set', theme),
  onThemeChanged: (cb: (theme: Theme) => void): (() => void) => subscribe('theme:changed', cb),
  getRecentFiles: (): Promise<string[]> => ipcRenderer.invoke('recent:list'),
  removeRecentFile: (path: string): Promise<void> => ipcRenderer.invoke('recent:remove', path),
  clearRecentFiles: (): Promise<void> => ipcRenderer.invoke('recent:clear'),
  openExternal: (url: string): void => ipcRenderer.send('shell:open-external', url),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('update:download'),
  installUpdate: (): void => ipcRenderer.send('update:install'),
  getUpdateState: (): Promise<UpdateEvent> => ipcRenderer.invoke('update:get-state'),
  onUpdateEvent: (cb: (event: UpdateEvent) => void): (() => void) => subscribe('update:event', cb),
  onMenuAction: (cb: (action: string) => void): (() => void) => subscribe('menu:action', cb),
  onCloseRequested: (cb: () => void): (() => void) => subscribe('app:close-requested', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
