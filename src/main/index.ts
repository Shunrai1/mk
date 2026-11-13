import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
  type BaseWindow,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'
import { basename, dirname, join, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { autoUpdater } from 'electron-updater'

const execFileAsync = promisify(execFile)

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

// 预览中的本地图片走自定义协议：开发模式页面源是 http://localhost，
// file:// 图片会被 webSecurity 拦截；mkimg:// 由主进程读盘返回字节，开发/打包均可用
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'mkimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const APP_NAME = 'Markdown笔记本'
const APP_USER_MODEL_ID = 'com.mkdown.notebook'
const NEW_WINDOW_FLAG = '--new-window'

// 开发模式与安装版隔离：独立应用名与 userData，
// 单实例锁（按 userData 路径区分）和本地配置互不干扰，两者可同时运行
if (!app.isPackaged) {
  app.setName(`${app.getName()}-dev`)
  app.setPath('userData', join(app.getPath('appData'), app.getName()))
}

/** 窗口标题：开发模式加标记，便于与安装版区分 */
const WINDOW_TITLE = app.isPackaged ? APP_NAME : `${APP_NAME}（开发）`

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

/** 主题：持久化到 userData，全部窗口共享；菜单单选与窗口背景色同步 */
type Theme = 'light' | 'dark' | 'grid'
const THEMES: readonly Theme[] = ['light', 'dark', 'grid']
const THEME_BG: Record<Theme, string> = { light: '#f5f6f8', dark: '#13161c', grid: '#fdf8e2' }
const themeStorePath = join(app.getPath('userData'), 'theme.json')
let currentTheme: Theme = 'light'

function loadTheme(): void {
  try {
    const data: unknown = JSON.parse(readFileSync(themeStorePath, 'utf-8'))
    const t = (data as { theme?: unknown } | null)?.theme
    if (typeof t === 'string' && (THEMES as readonly string[]).includes(t)) currentTheme = t as Theme
  } catch {
    currentTheme = 'light'
  }
}

function applyTheme(theme: Theme): void {
  if (!THEMES.includes(theme) || theme === currentTheme) return
  currentTheme = theme
  void writeFile(themeStorePath, JSON.stringify({ theme }), 'utf-8').catch(() => {})
  buildMenu()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.setBackgroundColor(THEME_BG[theme])
    sendTo(win, 'theme:changed', theme)
  }
}

type FileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; canceled?: boolean; error?: string }
type SaveResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
type ImageSaveResult =
  | { ok: true; path: string; absolutePath: string }
  | { ok: false; error: string }

/** 图片扩展名（不在白名单内的一律拒绝写入） */
function imageExtOf(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME[ext] ? ext : null
}

function uniqueImageName(ext: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `image-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`
}

/** 粘贴的图片落到文档旁 assets/ 目录；文档尚未保存时落到 userData/pasted-images */
async function storeImage(
  docPath: string | null,
  ext: string,
  write: (dest: string) => Promise<void>
): Promise<ImageSaveResult> {
  const relative = docPath !== null
  const dir = relative
    ? join(dirname(docPath), 'assets')
    : join(app.getPath('userData'), 'pasted-images')
  await mkdir(dir, { recursive: true })
  const fileName = uniqueImageName(ext)
  const absolutePath = join(dir, fileName)
  await write(absolutePath)
  return {
    ok: true,
    path: relative ? `assets/${fileName}` : absolutePath.replace(/\\/g, '/'),
    absolutePath
  }
}

function registerImageProtocol(): void {
  protocol.handle('mkimg', async (request) => {
    try {
      const raw = new URL(request.url).searchParams.get('p')
      if (!raw) return new Response('Bad Request', { status: 400 })
      const filePath = resolve(raw)
      if (!existsSync(filePath)) return new Response('Not Found', { status: 404 })
      // 只允许图片扩展名，避免该协议被用来读取任意文件
      const ext = imageExtOf(filePath)
      if (!ext) return new Response('Forbidden', { status: 403 })
      const data = await readFile(filePath)
      const mime = IMAGE_MIME[ext] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), { headers: { 'content-type': mime } })
    } catch {
      return new Response('Internal Error', { status: 500 })
    }
  })
}

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
  win.setTitle(`${name}${state.docDirty ? ' ●' : ''} - ${WINDOW_TITLE}`)
}

function createWindow(filePath: string | null = null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    title: WINDOW_TITLE,
    backgroundColor: THEME_BG[currentTheme],
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
    // 用户可能在其他地方（系统设置 / Finder）改过默认应用，重新切回本应用时复查一次；
    // 系统调用较贵，3 秒内只查一次
    const now = Date.now()
    if (now - lastDefaultCheck > 3000) {
      lastDefaultCheck = now
      void refreshDefaultState()
    }
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

  // 主题经 query 传入，渲染器首帧即可应用，避免加载闪烁
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('theme', currentTheme)
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { theme: currentTheme } })
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
/** 最近一次默认应用检测时间（毫秒），用于窗口聚焦时的复查节流 */
let lastDefaultCheck = 0

/** 查询注册表字符串值（兼容中文系统输出），不存在时返回 null */
async function queryRegValue(key: string, valueName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', key, ...(valueName ? ['/v', valueName] : ['/ve'])],
      { windowsHide: true }
    )
    // 值里可能有空格（electron-builder 注册的 ProgId 就叫「Markdown Document」），
    // 用 \S+ 会把值截断，导致后续比对永远不成立
    const m = stdout.match(/REG_SZ\s+(.+)/)
    if (!m) return null
    const v = m[1].trim()
    // 默认值未设置时 reg.exe 会输出「(值未设置)」/「(value not set)」占位文本，
    // 必须当作不存在，否则会中断回退链导致误判
    return v.startsWith('(') ? null : v
  } catch {
    return null
  }
}

/** 本应用在 Windows 上可能使用的 ProgId：安装期由 electron-builder 注册
    「Markdown Document」，运行期一键设置注册「mkdown.md」，两者都要认，
    否则通过系统设置选的默认应用会被误判为未默认。 */
const MD_PROGID = 'Markdown Document'
const MD_PROGIDS = [MD_PROGID, 'mkdown.md']

function isOwnProgId(v: string | null): boolean {
  if (v === null) return false
  if (MD_PROGIDS.includes(v)) return true
  // Win11 在「打开方式」里选中本应用后，UserChoice 记录的可能不是 ProgId 名，
  // 而是 `Applications\<exe 名>` 形式，也要认，否则用户明明选过了仍被判为未默认
  const m = v.match(/^Applications\\(.+)$/i)
  return (
    app.isPackaged && m !== null && m[1].toLowerCase() === basename(process.execPath).toLowerCase()
  )
}

/** 写 HKCU 注册表字符串值（isDefault 为 true 时写子键默认值） */
function addReg(key: string, name: string, data: string, isDefault = false): Promise<unknown> {
  return execFileAsync(
    'reg.exe',
    ['add', key, ...(isDefault ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', data, '/f'],
    { windowsHide: true }
  )
}

/** 执行 PowerShell 脚本，只返回纯 ASCII 结果。
    reg.exe 在中文 Windows 上输出 GBK，Node 按 UTF-8 解码会把中文路径变成乱码
    （`Markdown笔记本.exe` → 乱码），随后 existsSync 恒为 false。
    因此凡是需要拿到含中文的路径再比对的场景，一律在 PowerShell 内部完成，只回传 1/0。 */
async function runPowerShell(
  script: string,
  env: Record<string, string> = {}
): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, env: { ...process.env, ...env } }
  )
  return stdout.trim()
}

/** 当前生效的 .md ProgId：UserChoice → Win11 UserChoiceLatest → Classes 默认值 */
async function effectiveProgId(): Promise<string | null> {
  const userChoice = await queryRegValue(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice',
    'ProgId'
  )
  if (userChoice) return userChoice
  // Win11 22H2+ 改由 UserChoiceLatest 保存同一信息：ProgId 是子键，值名也叫 ProgId
  const latest = await queryRegValue(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoiceLatest\\ProgId',
    'ProgId'
  )
  if (latest) return latest
  return queryRegValue('HKCU\\Software\\Classes\\.md', '')
}

/** ProgId 名字对得上还不够：应用换过安装目录后，注册表里会残留旧路径，
    此时双击 .md 根本打不开，必须视为未正确关联。
    整个校验在 PowerShell 内完成（取命令 → 提 exe → 判存在 → 比文件名），只回传 1/0，
    避免中文安装路径经 reg.exe 的 GBK 输出被解码成乱码而恒判失败。 */
async function progIdHealthy(progId: string): Promise<boolean> {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    `$item=Get-Item -LiteralPath 'HKCU:\\Software\\Classes\\${progId}\\shell\\open\\command';` +
    "if(-not $item){'0';exit};" +
    "$c=$item.GetValue('');" +
    "if(-not $c){'0';exit};" +
    "$e=if($c -match '\"([^\"]+\\.exe)\"'){$Matches[1]}" +
    "elseif($c -match '([^\\s\"]+\\.exe)'){$Matches[1]}else{''};" +
    "if(-not $e -or -not (Test-Path -LiteralPath $e)){'0';exit};" +
    // 开发模式下无法注册自身，只要求关联指向一个真实存在的程序
    "if($env:MK_EXE -and ([IO.Path]::GetFileName($e) -ne $env:MK_EXE)){'0';exit};" +
    "'1'"
  try {
    const out = await runPowerShell(script, {
      MK_EXE: app.isPackaged ? basename(process.execPath) : ''
    })
    return out === '1'
  } catch {
    return false
  }
}

/** 把自有 ProgId 的打开命令与图标修正到当前安装位置（自愈，不改用户选择的默认程序）。
    是否已一致也交给 PowerShell 判断，避免每次窗口聚焦都因乱码而重写注册表。 */
async function ensureOwnRegistration(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const exePath = process.execPath
  const command = `"${exePath}" "%1"`
  const ids = MD_PROGIDS.map((p) => `'${p}'`).join(',')
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    `foreach($id in @(${ids})){` +
    '$item=Get-Item -LiteralPath "HKCU:\\Software\\Classes\\$id\\shell\\open\\command";' +
    "$c=if($item){$item.GetValue('')}else{''};" +
    "if($c -eq $env:MK_EXPECT){'1'}else{'0'}}"
  let flags: string[] = []
  try {
    flags = (await runPowerShell(script, { MK_EXPECT: command })).split(/\r?\n/)
  } catch {
    return
  }
  for (let i = 0; i < MD_PROGIDS.length; i++) {
    if (flags[i]?.trim() === '1') continue
    try {
      await addReg(`HKCU\\Software\\Classes\\${MD_PROGIDS[i]}\\shell\\open\\command`, '', command, true)
      await addReg(`HKCU\\Software\\Classes\\${MD_PROGIDS[i]}\\DefaultIcon`, '', `"${exePath}",0`, true)
    } catch {
      // 写入失败忽略，检测会返回未默认并引导用户到系统设置
    }
  }
}

/** macOS：应用 bundle id 与 Markdown 的 UTI */
const MAC_BUNDLE_ID = 'com.mkdown.notebook'
const MAC_MD_UTI = 'net.daringfireball.markdown'

/** macOS 当前把 .md 交给哪个 bundle（无默认时返回 null），走 LaunchServices。
    kLSRolesEditor 在 JXA 里没有可靠的常量桥接，直接用数值 4（CoreServices 定义）。 */
async function macDefaultHandler(): Promise<string | null> {
  const script =
    "ObjC.import('CoreServices');" +
    `var h = $.LSCopyDefaultRoleHandlerForContentType($('${MAC_MD_UTI}'), 4);` +
    'h ? ObjC.unwrap(h) : ""'
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      windowsHide: true
    })
    const v = stdout.trim()
    return v || null
  } catch {
    return null
  }
}

/** macOS 把 .md 的默认编辑器指向本应用 */
async function setMacDefaultHandler(): Promise<boolean> {
  const script =
    "ObjC.import('CoreServices');" +
    `$.LSSetDefaultRoleHandlerForContentType($('${MAC_MD_UTI}'), 4, $('${MAC_BUNDLE_ID}'));` +
    '""'
  try {
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 让 LaunchServices 重新登记本应用（应用刚安装/移动过时，设置默认可能因未登记而失败） */
async function registerMacBundle(): Promise<void> {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  // app.getPath('exe') 形如 …/X.app/Contents/MacOS/X，上溯三级即 .app 根目录
  const bundlePath = resolve(app.getPath('exe'), '../../..')
  try {
    await execFileAsync(lsregister, ['-f', bundlePath], { windowsHide: true })
  } catch {
    // lsregister 不可用时忽略
  }
}

/** 检测 .md 是否已默认用本应用打开 */
async function isDefaultMarkdownApp(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return (await macDefaultHandler()) === MAC_BUNDLE_ID
  }
  if (process.platform !== 'win32') return false
  const progId = await effectiveProgId()
  if (!progId || !isOwnProgId(progId)) return false
  // 名字命中后还要确认打开命令真的指向当前应用，否则旧安装路径会让双击失效
  return progIdHealthy(progId)
}

/** 将 .md / .markdown 的文件图标写为本应用图标并通知资源管理器刷新（尽力而为）。
    clearCache 用于显式设置默认后强制重建图标缓存；启动复查时只做轻量通知。 */
async function refreshFileIcons(clearCache: boolean): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return
  for (const progId of MD_PROGIDS) {
    try {
      await addReg(
        `HKCU\\Software\\Classes\\${progId}\\DefaultIcon`,
        '',
        `"${process.execPath}",0`,
        true
      )
    } catch {
      // 写入失败忽略
    }
  }
  if (clearCache) {
    try {
      await execFileAsync('ie4uinit.exe', ['-ClearIconCache'], { windowsHide: true })
    } catch {
      // 忽略
    }
  }
  try {
    await execFileAsync('ie4uinit.exe', ['-show'], { windowsHide: true })
  } catch {
    // 忽略
  }
  // SHCNE_ASSOCCHANGED：通知 shell 文件关联已变化，资源管理器据此重读文件图标
  const notify =
    "Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'; " +
    '[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)'
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', notify], {
      windowsHide: true
    })
  } catch {
    // 忽略
  }
}

/** 重新检测默认应用状态：同步菜单与所有窗口的工具栏按钮。
    每次启动 / 重复启动 / 设置成功后调用；已是默认时顺带确保文件图标指向本应用。 */
async function refreshDefaultState(): Promise<void> {
  // 先把可能残留的旧安装路径修正回当前运行位置，再判断是否默认
  await ensureOwnRegistration()
  const v = await isDefaultMarkdownApp()
  if (v === defaultAppRegistered) return
  defaultAppRegistered = v
  buildMenu()
  for (const win of BrowserWindow.getAllWindows()) sendTo(win, 'default:changed', v)
  if (v) void refreshFileIcons(false)
}

/**
 * Windows 默认应用注册（仅打包后生效）。
 * 注册自身能力后自动清除旧 UserChoice 并写入 .md/.markdown 默认 ProgId，
 * 再复查结果，无需用户去系统设置页手动选择。
 */
async function setDefaultMarkdownApp(): Promise<{ ok: boolean; message: string }> {
  if (process.platform === 'darwin') {
    if (!app.isPackaged) {
      return {
        ok: false,
        message: '开发模式没有正式的应用标识，无法注册默认应用。请使用打包后的应用设置。'
      }
    }
    await registerMacBundle()
    const called = await setMacDefaultHandler()
    let ok = called && (await isDefaultMarkdownApp())
    if (called && !ok) {
      // LaunchServices 落盘有延迟，稍等后复查一次
      await new Promise((r) => setTimeout(r, 500))
      ok = await isDefaultMarkdownApp()
    }
    if (ok) {
      defaultAppRegistered = true
      buildMenu()
      for (const win of BrowserWindow.getAllWindows()) sendTo(win, 'default:changed', true)
    }
    return ok
      ? { ok: true, message: '设置成功：.md 文件已默认使用 Markdown笔记本 打开。' }
      : {
          ok: false,
          message:
            '未能自动设为默认。请在 Finder 中右键任一 .md 文件 → 显示简介 → 打开方式选择“Markdown笔记本”→ 点击“全部更改”。'
        }
  }
  if (process.platform !== 'win32') {
    return { ok: false, message: '当前系统不支持自动注册默认应用。' }
  }
  if (!app.isPackaged) {
    return {
      ok: false,
      message: '开发模式无法注册默认应用。请先运行 npm run dist 生成安装包，安装后再点击此按钮。'
    }
  }
  try {
    // 先自愈：旧版本可能把 ProgId 的打开命令留在已删除的安装目录
    await ensureOwnRegistration()

    const exePath = process.execPath
    const exeName = basename(exePath)
    const appKey = `HKCU\\Software\\Classes\\Applications\\${exeName}`
    const command = `"${exePath}" "%1"`

    await addReg(`${appKey}\\shell\\open\\command`, '', command, true)
    await addReg(appKey, 'FriendlyAppName', APP_NAME)
    await addReg(`${appKey}\\SupportedTypes`, '.md', '')
    await addReg(`${appKey}\\SupportedTypes`, '.markdown', '')
    await addReg(`${appKey}\\Capabilities`, 'ApplicationName', APP_NAME)
    await addReg(`${appKey}\\Capabilities`, 'ApplicationDescription', 'Markdown 笔记本：编辑与预览 Markdown 文档')
    await addReg(`${appKey}\\Capabilities\\FileAssociations`, '.md', MD_PROGID)
    await addReg(`${appKey}\\Capabilities\\FileAssociations`, '.markdown', MD_PROGID)
    await addReg(`HKCU\\Software\\Classes\\${MD_PROGID}`, '', 'Markdown 文档', true)
    await addReg(`HKCU\\Software\\Classes\\${MD_PROGID}\\DefaultIcon`, '', `"${exePath}",0`, true)
    await addReg(`HKCU\\Software\\Classes\\${MD_PROGID}\\shell\\open\\command`, '', command, true)
    await addReg(
      'HKCU\\Software\\RegisteredApplications',
      'mkdown',
      `Software\\Classes\\Applications\\${exeName}\\Capabilities`
    )

    // 自动设为默认：清除旧的 UserChoice / UserChoiceLatest（不存在或删除失败则忽略），
    // 再写入扩展默认 ProgId。Win11 22H2+ 以 UserChoiceLatest 为准，只删 UserChoice 无效。
    const fileExtsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
    for (const ext of ['.md', '.markdown']) {
      for (const sub of ['UserChoice', 'UserChoiceLatest']) {
        try {
          await execFileAsync('reg.exe', ['delete', `${fileExtsKey}\\${ext}\\${sub}`, '/f'], {
            windowsHide: true
          })
        } catch {
          // 子键不存在或受系统保护时忽略
        }
      }
      await addReg(`HKCU\\Software\\Classes\\${ext}`, '', MD_PROGID, true)
    }
    // 文件图标写为本应用图标并强制刷新图标缓存
    await refreshFileIcons(true)

    const ok = await isDefaultMarkdownApp()
    if (ok) {
      defaultAppRegistered = true
      buildMenu()
      for (const win of BrowserWindow.getAllWindows()) sendTo(win, 'default:changed', true)
      return { ok: true, message: '设置成功：.md / .markdown 文件已默认使用 Markdown笔记本 打开。' }
    }
    // 自动写入被系统保护拦下时，直接带用户去系统「默认应用」设置页
    void shell.openExternal('ms-settings:defaultapps')
    return {
      ok: false,
      message:
        '系统未允许自动修改（Win11 保护默认应用设置）。已打开「默认应用」设置页：搜索 “Markdown” 或找到 .md，点「设置默认值」即可。'
    }
  } catch (err) {
    return { ok: false, message: `注册失败：${(err as Error).message}` }
  }
}

/** 自动更新：主进程广播事件，由渲染器展示通知，用户决定是否下载/安装 */
type UpdateEvent =
  | { type: 'idle' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }

type UpdateCheckResponse =
  | { ok: true; status: 'available' | 'not-available'; version?: string }
  | { ok: false; message: string }

let updateState: UpdateEvent = { type: 'idle' }
let updateCheckPromise: Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> | null = null

function broadcastUpdate(event: UpdateEvent): void {
  updateState = event
  for (const win of BrowserWindow.getAllWindows()) sendTo(win, 'update:event', event)
}

/** 复用进行中的检查，避免启动定时器/菜单/多窗口并发触发重复检查 */
function checkForUpdates(): Promise<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>> {
  if (!updateCheckPromise) {
    updateCheckPromise = autoUpdater.checkForUpdates().finally(() => {
      updateCheckPromise = null
    })
  }
  return updateCheckPromise
}

function setupAutoUpdater(): void {
  // 开发模式没有 app-update.yml，跳过
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    broadcastUpdate({ type: 'available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdate({ type: 'progress', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdate({ type: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    // 静默记录：启动自动检查失败（如离线）不打扰用户，手动操作的错误经 IPC 返回
    console.error('[autoUpdater]', err)
  })
  // 延迟启动检查，避免与首屏渲染争抢资源
  setTimeout(() => {
    void checkForUpdates().catch(() => {})
  }, 5000)
}

/** 检查更新并用原生对话框展示结果：菜单点击与渲染进程 IPC 共用同一套流程 */
async function checkForUpdatesWithDialog(win: BrowserWindow | null): Promise<UpdateCheckResponse> {
  const showBox = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)

  if (!app.isPackaged) {
    await showBox({
      type: 'info',
      title: '检查更新',
      message: '开发模式不支持检查更新',
      detail: '请使用安装版应用检查更新。',
      buttons: ['确定'],
      noLink: true
    })
    return { ok: false, message: '开发模式不支持检查更新，请使用安装版。' }
  }

  try {
    // 网络异常时不无限等待，超时后给出原生提示
    const result = await Promise.race([
      checkForUpdates(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 20000)
      })
    ])
    const version = result?.updateInfo.version
    if (version && version !== app.getVersion()) {
      const { response } = await showBox({
        type: 'info',
        title: '检查更新',
        message: `发现新版本 v${version}`,
        detail: `当前版本 v${app.getVersion()}。是否现在下载并安装？`,
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      if (response === 0) {
        void autoUpdater.downloadUpdate().catch((err) => {
          void showBox({
            type: 'error',
            title: '下载更新失败',
            message: '下载更新失败',
            detail: (err as Error).message,
            buttons: ['确定'],
            noLink: true
          })
        })
      }
      return { ok: true, status: 'available', version }
    }
    await showBox({
      type: 'info',
      title: '检查更新',
      message: '当前已是最新版本',
      detail: `当前版本 v${app.getVersion()}。`,
      buttons: ['确定'],
      noLink: true
    })
    return { ok: true, status: 'not-available' }
  } catch (err) {
    const message =
      (err as Error).message === 'timeout'
        ? '检查超时，请检查网络连接后重试。'
        : (err as Error).message
    await showBox({
      type: 'error',
      title: '检查更新失败',
      message: '检查更新失败',
      detail: message,
      buttons: ['确定'],
      noLink: true
    })
    return { ok: false, message }
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

  // 剪贴板图片：渲染器传原始字节，主进程按扩展名落盘并返回 Markdown 可用路径
  ipcMain.handle(
    'image:save',
    async (
      _e,
      payload: { data?: unknown; ext?: unknown; docPath?: unknown }
    ): Promise<ImageSaveResult> => {
      try {
        const ext = String(payload?.ext ?? 'png').toLowerCase()
        if (!IMAGE_MIME[ext]) return { ok: false, error: '不支持的图片格式' }
        const data = payload?.data
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data instanceof Uint8Array
              ? data
              : null
        if (!bytes || bytes.byteLength === 0) return { ok: false, error: '剪贴板中没有图片数据' }
        const docPath = typeof payload?.docPath === 'string' ? payload.docPath : null
        return await storeImage(docPath, ext, (dest) => writeFile(dest, bytes))
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // 从资源管理器复制来的图片文件：直接复制原文件，避免重新编码
  ipcMain.handle(
    'image:import',
    async (_e, payload: { sourcePath?: unknown; docPath?: unknown }): Promise<ImageSaveResult> => {
      try {
        const sourcePath = typeof payload?.sourcePath === 'string' ? payload.sourcePath : ''
        if (!sourcePath || !existsSync(sourcePath)) return { ok: false, error: '图片文件不存在' }
        const ext = imageExtOf(sourcePath)
        if (!ext) return { ok: false, error: '不支持的图片格式' }
        const docPath = typeof payload?.docPath === 'string' ? payload.docPath : null
        return await storeImage(docPath, ext, (dest) => copyFile(sourcePath, dest))
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

  ipcMain.handle('theme:get', (): Theme => currentTheme)
  ipcMain.on('theme:set', (_e, theme: Theme) => applyTheme(theme))

  ipcMain.handle('recent:list', (): string[] => [...recentFiles])

  ipcMain.handle('recent:remove', (_e, filePath: string) => {
    if (typeof filePath === 'string') removeRecentFile(filePath)
  })

  ipcMain.handle('recent:clear', () => {
    recentFiles = []
    saveRecentFiles()
    if (RECENT_DOCS_SUPPORTED) app.clearRecentDocuments()
  })

  ipcMain.handle('update:get-state', (): UpdateEvent => updateState)

  ipcMain.handle('update:check', (e) => checkForUpdatesWithDialog(windowOf(e)))

  ipcMain.handle('update:download', async (): Promise<{ ok: boolean; message?: string }> => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.on('update:install', () => {
    autoUpdater.quitAndInstall()
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
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        {
          label: '查找…',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, win) => sendTo(menuTarget(win), 'menu:action', 'find')
        }
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
        {
          label: '主题',
          submenu: [
            {
              label: '明亮',
              type: 'radio',
              checked: currentTheme === 'light',
              click: () => applyTheme('light')
            },
            {
              label: '暗黑',
              type: 'radio',
              checked: currentTheme === 'dark',
              click: () => applyTheme('dark')
            },
            {
              label: '网格（浅黄方格纸）',
              type: 'radio',
              checked: currentTheme === 'grid',
              click: () => applyTheme('grid')
            }
          ]
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
          label: '检查更新…',
          click: (_item, win) => {
            // 直接在主进程检查并弹原生对话框，避免开发模式等场景下渲染进程链路失效
            void checkForUpdatesWithDialog(menuTarget(win))
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

// Windows 任务栏分组与跳转列表需要稳定的 AppUserModelId；开发模式用独立身份，避免与安装版合并分组
app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}-dev`)

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  // 单进程多窗口：重复启动不再抢占已有窗口，按需新开窗口
  app.on('second-instance', (_e, argv) => {
    // 重复启动也视为一次「启动」：重新检测默认应用状态
    void refreshDefaultState()
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
    loadTheme()
    registerIpc()
    registerImageProtocol()
    buildMenu()
    registerUserTasks()
    setupAutoUpdater()
    createWindow(earlyOpenPath ?? fileFromArgv(process.argv))
    void refreshDefaultState()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}