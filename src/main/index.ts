import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type BaseWindow,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'
import { basename, join, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i
const APP_NAME = 'Markdown笔记本'
const APP_USER_MODEL_ID = 'com.mkdown.notebook'
const NEW_WINDOW_FLAG = '--new-window'

/** 每个窗口独立维护文档状态，互不影响 */
type WindowState = {
  allowClose: boolean
  docDirty: boolean
  docPath: string | null
  initialFilePath: string | null
}

const windowStates = new Map<number, WindowState>()
let lastFocusedWindow: BrowserWindow | null = null
/** macOS 在窗口创建前投递的 open-file 路径 */
let earlyOpenPath: string | null = null

/** 最近打开的文件：持久化到 userData，并同步到系统任务栏右键「最近」跳转列表 */
const MAX_RECENT_FILES = 10
const RECENT_DOCS_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin'
const recentStorePath = join(app.getPath('userData'), 'recent-files.json')
let recentFiles: string[] = []

function loadRecentFiles(): void {
  try {
    const data: unknown = JSON.parse(readFileSync(recentStorePath, 'utf-8'))
    if (Array.isArray(data)) {
      recentFiles = data.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FILES)
    }
  } catch {
    recentFiles = []
  }
}

function saveRecentFiles(): void {
  void writeFile(recentStorePath, JSON.stringify(recentFiles), 'utf-8').catch(() => {})
}

function recordRecentFile(filePath: string): void {
  const p = resolve(filePath)
  recentFiles = [p, ...recentFiles.filter((x) => x !== p)].slice(0, MAX_RECENT_FILES)
  saveRecentFiles()
  if (RECENT_DOCS_SUPPORTED) app.addRecentDocument(p)
}

function removeRecentFile(filePath: string): void {
  if (!recentFiles.includes(filePath)) return
  recentFiles = recentFiles.filter((p) => p !== filePath)
  saveRecentFiles()
  if (RECENT_DOCS_SUPPORTED) {
    // Electron 无单项移除 API：清空后按剩余列表重建（倒序添加以保持最新在前）
    app.clearRecentDocuments()
    for (const p of [...recentFiles].reverse()) app.addRecentDocument(p)
  }
}

type FileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; canceled?: boolean; error?: string }
type SaveResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }

function fileFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    if (MD_EXT.test(arg) && existsSync(arg)) return resolve(arg)
  }
  return null
}

async function readDocument(filePath: string): Promise<{ path: string; content: string }> {
  const raw = await readFile(filePath, 'utf-8')
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  recordRecentFile(filePath)
  return { path: filePath, content }
}

function sendTo(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** IPC 调用方所属窗口 */
function windowOf(e: IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/** 菜单/快捷键作用的目标窗口 */
function activeWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    lastFocusedWindow ??
    BrowserWindow.getAllWindows()[0] ??
    null
  )
}

/** 菜单项点击时的目标窗口（Electron 传入的是聚焦窗口） */
function menuTarget(win?: BaseWindow): BrowserWindow | null {
  return (win ? BrowserWindow.fromId(win.id) : null) ?? activeWindow()
}

function updateTitle(win: BrowserWindow): void {
  const state = windowStates.get(win.id)
  if (!state) return
  const name = state.docPath ? basename(state.docPath) : '未命名'
  win.setTitle(`${name}${state.docDirty ? ' ●' : ''} - ${APP_NAME}`)
}

function createWindow(filePath: string | null = null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: '#f5f6f8',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  windowStates.set(win.id, {
    allowClose: false,
    docDirty: false,
    docPath: null,
    initialFilePath: filePath
  })
  lastFocusedWindow = win

  win.on('focus', () => {
    lastFocusedWindow = win
  })
  win.on('ready-to-show', () => win.show())

  // 未保存关闭保护：交由该窗口的渲染器弹出确认对话框
  win.on('close', (e) => {
    const state = windowStates.get(win.id)
    if (state && !state.allowClose && state.docDirty) {
      e.preventDefault()
      sendTo(win, 'app:close-requested')
    }
  })
  win.on('closed', () => {
    windowStates.delete(win.id)
    if (lastFocusedWindow === win) lastFocusedWindow = null
  })

  // 安全：拒绝新窗口与页面内跳转，外链走系统浏览器
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** 打开文件：已在某窗口打开则聚焦该窗口，否则新开窗口 */
function openPathInWindow(filePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const state = windowStates.get(win.id)
    if (state?.docPath === filePath) {
      focusWindow(win)
      return
    }
  }
  createWindow(filePath)
}

/** 任务栏右键「新建窗口」：打包后直接启动自身，开发模式需带上应用目录 */
function registerUserTasks(): void {
  if (process.platform !== 'win32') return
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: app.isPackaged
        ? NEW_WINDOW_FLAG
        : `"${app.getAppPath()}" ${NEW_WINDOW_FLAG}`,
      iconPath: process.execPath,
      iconIndex: 0,
      title: '新建窗口',
      description: '打开一个空白的 Markdown 窗口'
    }
  ])
}

let defaultAppRegistered = false

/** 查询注册表字符串值（兼容中文系统输出），不存在时返回 null */
async function queryRegValue(key: string, valueName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', key, ...(valueName ? ['/v', valueName] : ['/ve'])],
      { windowsHide: true }
    )
    const m = stdout.match(/REG_SZ\s+(\S+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** 检测 .md 是否已默认用本应用打开：优先 UserChoice，其次 Classes\.md 默认值 */
async function isDefaultMarkdownApp(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const userChoice = await queryRegValue(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice',
    'ProgId'
  )
  if (userChoice) return userChoice === 'mkdown.md'
  return (await queryRegValue('HKCU\\Software\\Classes\\.md', '')) === 'mkdown.md'
}

/**
 * Windows 默认应用注册（仅打包后生效）。
 * 注册自身能力后自动清除旧 UserChoice 并写入 .md/.markdown 默认 ProgId，
 * 再复查结果，无需用户去系统设置页手动选择。
 */
async function setDefaultMarkdownApp(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, message: '当前仅支持 Windows 自动注册，其他系统请在文件属性中手动选择打开方式。' }
  }
  if (!app.isPackaged) {
    return {
      ok: false,
      message: '开发模式无法注册默认应用。请先运行 npm run dist 生成安装包，安装后再点击此按钮。'
    }
  }
  try {
    const exePath = process.execPath
    const exeName = basename(exePath)
    const appKey = `HKCU\\Software\\Classes\\Applications\\${exeName}`
    const progId = 'mkdown.md'
    const command = `"${exePath}" "%1"`
    const add = (key: string, name: string, data: string, isDefault = false): Promise<unknown> =>
      execFileAsync(
        'reg.exe',
        ['add', key, ...(isDefault ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', data, '/f'],
        { windowsHide: true }
      )

    await add(`${appKey}\\shell\\open\\command`, '', command, true)
    await add(appKey, 'FriendlyAppName', APP_NAME)
    await add(`${appKey}\\SupportedTypes`, '.md', '')
    await add(`${appKey}\\SupportedTypes`, '.markdown', '')
    await add(`${appKey}\\Capabilities`, 'ApplicationName', APP_NAME)
    await add(`${appKey}\\Capabilities`, 'ApplicationDescription', 'Markdown 笔记本：编辑与预览 Markdown 文档')
    await add(`${appKey}\\Capabilities\\FileAssociations`, '.md', progId)
    await add(`${appKey}\\Capabilities\\FileAssociations`, '.markdown', progId)
    await add(`HKCU\\Software\\Classes\\${progId}`, '', 'Markdown 文档', true)
    await add(`HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, '', `"${exePath},0"`, true)
    await add(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '', command, true)
    await add(
      'HKCU\\Software\\RegisteredApplications',
      'mkdown',
      `Software\\Classes\\Applications\\${exeName}\\Capabilities`
    )

    // 自动设为默认：清除旧 UserChoice（不存在或删除失败则忽略），再写入默认 ProgId
    const fileExtsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
    for (const ext of ['.md', '.markdown']) {
      try {
        await execFileAsync('reg.exe', ['delete', `${fileExtsKey}\\${ext}\\UserChoice`, '/f'], {
          windowsHide: true
        })
      } catch {
        // UserChoice 不存在或受保护时忽略
      }
      await add(`HKCU\\Software\\Classes\\${ext}`, '', progId, true)
    }
    // 通知资源管理器刷新文件图标（尽力而为）
    try {
      await execFileAsync('ie4uinit.exe', ['-show'], { windowsHide: true })
    } catch {
      // 刷新失败忽略
    }

    const ok = await isDefaultMarkdownApp()
    if (ok) {
      defaultAppRegistered = true
      buildMenu()
    }
    return ok
      ? { ok: true, message: '设置成功：.md / .markdown 文件已默认使用 Markdown笔记本 打开。' }
      : {
          ok: false,
          message:
            '未能自动设为默认应用（受系统权限限制）。请在 Windows 设置 → 应用 → 默认应用中按文件类型 .md 选择“Markdown笔记本”。'
        }
  } catch (err) {
    return { ok: false, message: `注册失败：${(err as Error).message}` }
  }
}

function registerIpc(): void {
  ipcMain.handle('file:open', async (e): Promise<FileResult> => {
    const win = windowOf(e)
    if (!win) return { ok: false, canceled: true }
    const result = await dialog.showOpenDialog(win, {
      title: '打开 Markdown 文件',
      filters: [
        { name: 'Markdown 文件', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      return { ok: true, ...(await readDocument(result.filePaths[0])) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('file:open-path', async (_e, filePath: string): Promise<FileResult> => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) {
      // 文件已被删除/移动：顺带从最近列表移除失效记录
      if (typeof filePath === 'string') removeRecentFile(filePath)
      return { ok: false, error: '文件不存在' }
    }
    try {
      return { ok: true, ...(await readDocument(resolve(filePath))) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('file:save', async (_e, filePath: string, content: string): Promise<SaveResult> => {
    try {
      await writeFile(filePath, content, 'utf-8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'file:save-as',
    async (e, content: string, defaultPath?: string): Promise<SaveResult> => {
      const win = windowOf(e)
      if (!win) return { ok: false, canceled: true }
      const result = await dialog.showSaveDialog(win, {
        title: '另存为',
        defaultPath: defaultPath ?? '未命名.md',
        filters: [
          { name: 'Markdown 文件', extensions: ['md'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        await writeFile(result.filePath, content, 'utf-8')
        recordRecentFile(result.filePath)
        return { ok: true, path: result.filePath }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('file:initial', async (e): Promise<FileResult | null> => {
    const win = windowOf(e)
    const state = win ? windowStates.get(win.id) : undefined
    if (!win || !state) return null
    if (!state.initialFilePath) return null
    try {
      return { ok: true, ...(await readDocument(state.initialFilePath)) }
    } catch {
      return null
    }
  })

  ipcMain.on('doc:state', (e, state: { dirty: boolean; path: string | null }) => {
    const win = windowOf(e)
    const current = win ? windowStates.get(win.id) : undefined
    if (!win || !current) return
    current.docDirty = Boolean(state?.dirty)
    current.docPath = typeof state?.path === 'string' ? state.path : null
    updateTitle(win)
  })

  ipcMain.on('app:force-close', (e) => {
    const win = windowOf(e)
    const state = win ? windowStates.get(win.id) : undefined
    if (!win || !state) return
    state.allowClose = true
    win.close()
  })

  ipcMain.on('app:new-window', () => {
    createWindow()
  })

  ipcMain.on('shell:open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
  })

  ipcMain.handle('app:set-default', () => setDefaultMarkdownApp())
  ipcMain.handle('app:get-default-state', () => isDefaultMarkdownApp())

  ipcMain.handle('recent:list', (): string[] => [...recentFiles])

  ipcMain.handle('recent:remove', (_e, filePath: string) => {
    if (typeof filePath === 'string') removeRecentFile(filePath)
  })

  ipcMain.handle('recent:clear', () => {
    recentFiles = []
    saveRecentFiles()
    if (RECENT_DOCS_SUPPORTED) app.clearRecentDocuments()
  })
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件(&F)',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: '打开…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'open')
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'save')
        },
        {
          label: '另存为…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'save-as')
        },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        {
          label: '编辑模式',
          accelerator: 'CmdOrCtrl+1',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'view-edit')
        },
        {
          label: '分屏模式',
          accelerator: 'CmdOrCtrl+2',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'view-split')
        },
        {
          label: '预览模式',
          accelerator: 'CmdOrCtrl+3',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'view-preview')
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: defaultAppRegistered ? '已是 Markdown 默认应用' : '设为 Markdown 默认应用',
          enabled: !defaultAppRegistered,
          click: () => {
            void setDefaultMarkdownApp().then((r) => {
              const win = activeWindow()
              if (win) {
                dialog.showMessageBox(win, {
                  type: r.ok ? 'info' : 'warning',
                  title: '默认应用',
                  message: r.message
                })
              }
            })
          }
        },
        {
          label: '关于',
          click: () => {
            const win = activeWindow()
            if (win) {
              dialog.showMessageBox(win, {
                type: 'info',
                title: '关于',
                message: APP_NAME,
                detail: `版本 ${app.getVersion()}\nElectron + React + TypeScript\n打开、编辑、渲染并保存 Markdown 文件。`
              })
            }
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Windows 任务栏分组与跳转列表需要稳定的 AppUserModelId
app.setAppUserModelId(APP_USER_MODEL_ID)

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  // 单进程多窗口：重复启动不再抢占已有窗口，按需新开窗口
  app.on('second-instance', (_e, argv) => {
    if (argv.includes(NEW_WINDOW_FLAG)) {
      createWindow()
      return
    }
    const file = fileFromArgv(argv)
    if (file) {
      openPathInWindow(file)
      return
    }
    const win = activeWindow()
    if (win) focusWindow(win)
  })

  // macOS：系统级文件打开事件
  app.on('open-file', (e, path) => {
    e.preventDefault()
    if (BrowserWindow.getAllWindows().length === 0) earlyOpenPath = resolve(path)
    else openPathInWindow(resolve(path))
  })

  app.whenReady().then(() => {
    loadRecentFiles()
    registerIpc()
    buildMenu()
    registerUserTasks()
    createWindow(earlyOpenPath ?? fileFromArgv(process.argv))
    void isDefaultMarkdownApp().then((v) => {
      if (v !== defaultAppRegistered) {
        defaultAppRegistered = v
        buildMenu()
      }
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}