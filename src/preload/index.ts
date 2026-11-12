import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type FileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; canceled?: boolean; error?: string }
export type SaveResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }

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
  setDocState: (state: { dirty: boolean; path: string | null }): void =>
    ipcRenderer.send('doc:state', state),
  forceClose: (): void => ipcRenderer.send('app:force-close'),
  newWindow: (): void => ipcRenderer.send('app:new-window'),
  setDefaultApp: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('app:set-default'),
  getDefaultState: (): Promise<boolean> => ipcRenderer.invoke('app:get-default-state'),
  getRecentFiles: (): Promise<string[]> => ipcRenderer.invoke('recent:list'),
  removeRecentFile: (path: string): Promise<void> => ipcRenderer.invoke('recent:remove', path),
  clearRecentFiles: (): Promise<void> => ipcRenderer.invoke('recent:clear'),
  openExternal: (url: string): void => ipcRenderer.send('shell:open-external', url),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onMenuAction: (cb: (action: string) => void): (() => void) => subscribe('menu:action', cb),
  onCloseRequested: (cb: () => void): (() => void) => subscribe('app:close-requested', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
