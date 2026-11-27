/** 为渲染进程提供受控的 Electron 文件、窗口和系统接口。 */
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

/** 订阅指定的主进程事件，并返回取消订阅的函数。 */
function subscribe(channel: string, cb: (...args: never[]) => void): () => void {
  /** 转发事件数据，避免向渲染进程暴露 IPC 事件对象。 */
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as never[]))
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// 仅暴露白名单 API，渲染器不直接接触 ipcRenderer / Node
const api = {
  /** 通过系统对话框打开文件。 */
  openFile: (): Promise<FileResult> => ipcRenderer.invoke('file:open'),
  /** 打开指定路径的文件。 */
  openPath: (path: string): Promise<FileResult> => ipcRenderer.invoke('file:open-path', path),
  /** 从磁盘重新读取当前文档。 */
  reloadFile: (path: string): Promise<FileResult> => ipcRenderer.invoke('file:reload', path),
  /** 订阅当前文档的磁盘变动。 */
  onFileChanged: (cb: (path: string) => void): (() => void) => subscribe('file:changed', cb),
  /** 核对上次载入或保存的内容后保存当前文档。 */
  saveFile: (path: string, content: string, savedContent: string): Promise<SaveResult> =>
    ipcRenderer.invoke('file:save', path, content, savedContent),
  /** 选择新路径并保存文档。 */
  saveFileAs: (content: string, defaultPath?: string): Promise<SaveResult> =>
    ipcRenderer.invoke('file:save-as', content, defaultPath),
  /** 读取启动时传入的文档。 */
  getInitialFile: (): Promise<FileResult | null> => ipcRenderer.invoke('file:initial'),
  /** 将粘贴的图片字节保存到磁盘。 */
  savePastedImage: (data: ArrayBuffer, ext: string, docPath: string | null): Promise<ImageSaveResult> =>
    ipcRenderer.invoke('image:save', { data, ext, docPath }),
  /** 复制外部图片并返回 Markdown 可用的路径。 */
  importImageFile: (sourcePath: string, docPath: string | null): Promise<ImageSaveResult> =>
    ipcRenderer.invoke('image:import', { sourcePath, docPath }),
  /** 上报当前文档的路径和未保存状态。 */
  setDocState: (state: { dirty: boolean; path: string | null }): void =>
    ipcRenderer.send('doc:state', state),
  /** 在用户确认后关闭当前窗口。 */
  forceClose: (): void => ipcRenderer.send('app:force-close'),
  /** 创建新的笔记窗口。 */
  newWindow: (): void => ipcRenderer.send('app:new-window'),
  /** 尝试将应用设为 Markdown 的默认打开方式。 */
  setDefaultApp: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('app:set-default'),
  /** 查询系统中当前的默认 Markdown 应用状态。 */
  getDefaultState: (): Promise<boolean> => ipcRenderer.invoke('app:get-default-state'),
  /** 订阅默认打开方式的状态变化。 */
  onDefaultChanged: (cb: (isDefault: boolean) => void): (() => void) => subscribe('default:changed', cb),
  /** 读取应用的当前主题。 */
  getTheme: (): Promise<Theme> => ipcRenderer.invoke('theme:get'),
  /** 设定所有窗口使用的主题。 */
  setTheme: (theme: Theme): void => ipcRenderer.send('theme:set', theme),
  /** 订阅主题变化。 */
  onThemeChanged: (cb: (theme: Theme) => void): (() => void) => subscribe('theme:changed', cb),
  /** 获取最近打开的文件路径。 */
  getRecentFiles: (): Promise<string[]> => ipcRenderer.invoke('recent:list'),
  /** 从最近文件列表中移除指定路径。 */
  removeRecentFile: (path: string): Promise<void> => ipcRenderer.invoke('recent:remove', path),
  /** 清空最近文件列表。 */
  clearRecentFiles: (): Promise<void> => ipcRenderer.invoke('recent:clear'),
  /** 用系统浏览器打开外部链接。 */
  openExternal: (url: string): void => ipcRenderer.send('shell:open-external', url),
  /** 获取拖入或粘贴的文件在磁盘上的路径。 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 发起应用更新检查。 */
  checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check'),
  /** 下载可用的应用更新。 */
  downloadUpdate: (): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('update:download'),
  /** 重启应用并安装已下载的更新。 */
  installUpdate: (): void => ipcRenderer.send('update:install'),
  /** 读取当前的应用更新状态。 */
  getUpdateState: (): Promise<UpdateEvent> => ipcRenderer.invoke('update:get-state'),
  /** 订阅应用更新状态。 */
  onUpdateEvent: (cb: (event: UpdateEvent) => void): (() => void) => subscribe('update:event', cb),
  /** 订阅应用菜单与快捷键操作。 */
  onMenuAction: (cb: (action: string) => void): (() => void) => subscribe('menu:action', cb),
  /** 订阅需要确认未保存修改的关闭请求。 */
  onCloseRequested: (cb: () => void): (() => void) => subscribe('app:close-requested', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
