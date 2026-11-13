# agent.md — Markdown 笔记本开发参考指南

> 本指南依据 Electron 官方文档整理：https://www.electronjs.org/zh/docs/latest/
> 重点参考：教程 / 进程模型（tutorial/process-model）、最佳实践 / 安全（tutorial/security）、
> 进程间通信（tutorial/ipc）、应用分发（tutorial/application-distribution）。

## 1. 项目定位

Windows 桌面 Markdown 笔记本：

- 打开 `.md / .markdown / .mdown / .mkd` 文件（对话框、拖拽、命令行参数、双击文件）
- 最近打开的文件：工具栏「打开」旁的下拉箭头列出最近 10 个文件（可清空）；
  同时写入系统任务栏右键「最近」跳转列表，点击即可打开对应文件
- 编辑（CodeMirror 6）+ 实时渲染（CommonMark + GFM + 数学公式 + 代码高亮 + Mermaid 图表）
- 保存 / 另存为，未保存关闭保护
- 一键将本应用设为 Markdown 文件的默认打开方式（设置成功后按钮自动隐藏）
- 多窗口：Ctrl+N / 工具栏「新建」/ 菜单「新建窗口」/ 任务栏右键「新建窗口」均可新开空白窗口；
  重复启动时聚焦已有窗口，双击文件时若该文件已打开则聚焦对应窗口，否则新开窗口

技术栈：Electron + electron-vite + React 18 + TypeScript。

## 2. 进程模型（官方文档要点）

Electron 继承 Chromium 多进程架构：

| 进程 | 职责 | 本项目位置 |
| ---- | ---- | ---- |
| 主进程（Main） | 唯一入口，Node.js 环境，管理 `BrowserWindow` 与应用生命周期，执行文件 IO / 系统注册 | `src/main/index.ts` |
| 预加载脚本（Preload） | 在渲染器加载前运行，通过 `contextBridge` 暴露最小化、受控的 API | `src/preload/index.ts` |
| 渲染进程（Renderer） | Chromium 页面，运行 React UI，**不直接接触 Node.js** | `src/renderer/` |

要点：

- 渲染进程崩溃不影响主进程；窗口只是渲染进程的宿主。
- 只有主进程能调用原生 GUI / 文件系统 API，渲染进程一律走 IPC。
- 预加载脚本与渲染器共享 `window`，但默认处于隔离上下文（contextIsolation）。
- 单进程多窗口：主进程用 `windowStates: Map<windowId, WindowState>` 按窗口保存
  脏标记 / 文档路径 / 就绪状态 / 待打开路径；IPC 一律用 `BrowserWindow.fromWebContents(e.sender)`
  定位调用方窗口，菜单动作用点击时传入的聚焦窗口（`menuTarget`）。禁止再引入全局单窗口变量。
- 任务栏跳转列表：`app.setUserTasks` 注册「新建窗口」，参数 `--new-window`
  （开发模式额外带上 `app.getAppPath()`）；`second-instance` 见到该标记即新开空白窗口。
  Windows 下需 `app.setAppUserModelId('com.mkdown.notebook')` 保证任务栏分组稳定。
  「最近」分类由 `app.addRecentDocument` 写入（每次成功打开/另存为时记录），
  点击最近项会以文件路径启动应用，复用 `second-instance` / 启动参数逻辑打开。

## 3. 安全清单（官方 tutorial/security 对照实现）

1. ✅ 仅加载本地内容（生产 `loadFile`，开发为本地 vite dev server）。
2. ✅ `contextIsolation: true`、`nodeIntegration: false`，渲染器无 Node 能力。
3. ✅ `contextBridge.exposeInMainWorld` 只暴露白名单 API，不透传 `ipcRenderer` 整体。
4. ✅ 主进程校验 IPC 输入（外链仅允许 http/https，文件读取限定路径存在）。
5. ✅ `setWindowOpenHandler` 拒绝页面内 `window.open`（应用窗口只由主进程 `createWindow` 创建）；`will-navigate` 拦截页面跳转。
6. ✅ 外部链接交给系统浏览器（`shell.openExternal`），不在应用内打开。
7. ✅ 单实例锁（`requestSingleInstanceLock`）：仅一个主进程，重复启动按参数聚焦或新开窗口。
8. ✅ 渲染本地图片统一改写为 `mkimg://` 自定义协议（主进程读盘返回字节），开发/打包模式均可显示；`file://` 在开发模式受 webSecurity 限制，仅作为兜底解析。

## 4. IPC 契约

渲染器调用（`window.api`，invoke/send 封装见 preload）：

| 通道 | 方向 | 说明 |
| ---- | ---- | ---- |
| `file:open` | invoke | 打开文件对话框 → 读取内容 |
| `file:open-path` | invoke | 读取指定路径（渲染器拖拽） |
| `file:save` | invoke | 写入已命名文件 |
| `file:save-as` | invoke | 另存为对话框 → 写入 |
| `file:initial` | invoke | 取本窗口创建时传入的文件路径并读取内容 |
| `image:save` | invoke | 粘贴的剪贴板位图落盘（文档旁 `assets/`，未保存文档落 `userData/pasted-images`）→ 返回 Markdown 路径 |
| `image:import` | invoke | 粘贴/复制来的图片文件复制进同一目录，避免重新编码 |
| `doc:state` | send | 上报脏标记与路径，主进程维护该窗口标题与关闭保护 |
| `app:close-requested` | 主→渲染 | 有未保存内容时请求该窗口渲染器弹出保存确认 |
| `app:force-close` | send | 用户确认后强制关闭该窗口 |
| `app:new-window` | send | 新开一个空白窗口（工具栏「新建」） |
| `menu:action` | 主→渲染 | 菜单/快捷键动作（open/save/save-as/find/view-*/set-default） |
| `shell:open-external` | send | 用系统浏览器打开 http(s) 链接 |
| `app:set-default` | invoke | 一键自动设置 .md 默认打开方式（见下节） |
| `app:get-default-state` | invoke | 检测 .md 是否已默认用本应用打开（决定是否隐藏按钮） |
| `recent:list` | invoke | 取最近打开的文件路径列表（最多 10 条，最新在前） |
| `recent:remove` | invoke | 移除一条最近记录（文件失效时由 `file:open-path` 自动调用） |
| `recent:clear` | invoke | 清空最近记录，并同步清空系统跳转列表「最近」 |

## 5. 文件关联与默认打开方式

本项目采用「安装期注册 + 运行期一键自动设置」，Windows 与 macOS 分别实现：

1. **安装期**：electron-builder NSIS 配置 `fileAssociations`（.md / .markdown，role: Editor，
   mimeType: text/markdown），安装后出现在"打开方式"候选列表；macOS 据此生成
   `CFBundleDocumentTypes`，LaunchServices 才能把 `.md`（UTI `net.daringfireball.markdown`）
   登记到本应用名下。
2. **运行期（Windows）**：应用内「设为默认应用」按钮 / 帮助菜单（仅打包后生效）向 HKCU 写入：
   - `Software\Classes\Applications\<exe 名>`：open 命令、FriendlyAppName、SupportedTypes
   - `...\Capabilities\FileAssociations`：`.md / .markdown → Markdown Document` ProgId
   - `Software\Classes\Markdown Document`：ProgId 描述、DefaultIcon、open 命令
     （与安装期 electron-builder 使用同一个 ProgId，避免两套 ProgId 并存）
   - `Software\RegisteredApplications`：登记 Capabilities
   随后自动完成默认设置，无需打开系统设置页：
   - 删除 `Explorer\FileExts\.md / .markdown` 的旧 `UserChoice` **与 `UserChoiceLatest`**
     （不存在或失败则忽略）。Win11 22H2+ 以 `UserChoiceLatest` 为准，只删 `UserChoice` 无效；
     注意它是**子键**：路径为 `UserChoiceLatest\ProgId`，值名也叫 `ProgId`，用 `/ve` 读不到。
   - 写入 `Software\Classes\.md / .markdown` 默认值为 `Markdown Document`
   - 删除被系统保护、写入未生效时 `shell.openExternal('ms-settings:defaultapps')`
     直接带用户到系统设置页兜底
   - `ie4uinit.exe -show` 刷新资源管理器图标（尽力而为）
3. **运行期（macOS）**：`osascript -l JavaScript` 调用 LaunchServices：
   - 设置：`LSSetDefaultRoleHandlerForContentType('net.daringfireball.markdown', 4, 'com.mkdown.notebook')`
   - 检测：`LSCopyDefaultRoleHandlerForContentType(uti, 4)` 取当前 bundle id 比对
   - `kLSRolesEditor` 在 JXA 中常量桥接不可靠，直接传数值 `4`；字符串参数用 `$()` 包成 CFStringRef
   - 失败时提示用户在 Finder「显示简介 → 全部更改」手动设置
4. **状态检测**：
   - Windows：依次读 `UserChoice.ProgId` → `UserChoiceLatest\ProgId`（`/v ProgId`）→
     `Classes\.md` 默认值，任一命中本应用即为默认。本应用的 ProgId 有两个：
     运行期注册的 `mkdown.md`，以及 electron-builder 安装期用 association `name` 生成的
     `Markdown Document`（含空格），两者都要认，否则通过系统设置选的默认会被误判。
   - `reg.exe query` 解析坑：值里可能有空格（必须 `/REG_SZ\s+(.+)/` 后再 `trim()`，
     用 `\S+` 会把 `Markdown Document` 截成 `Markdown`）；值未设置时输出占位文本
     「(值未设置)」/「(value not set)」，必须当作不存在，否则会中断回退链导致误判。
   - **编码坑（必须遵守）**：中文 Windows 下 `reg.exe` 输出是 GBK，Node 的 `execFile` 默认按
     UTF-8 解码，含中文的 exe 路径（如 `Markdown笔记本.exe`）会变成乱码，
     `existsSync`/字符串比对因此恒为 false——注册表明明正确，检测却一直判「未默认」并弹出
     fallback 提示。凡是要拿含中文的路径做判断的，一律改用 PowerShell
     （`Get-Item -LiteralPath` + `.GetValue('')` + `Test-Path`）在脚本内部完成比对，
     只回传 `1`/`0` 这类纯 ASCII 结果（见 `runPowerShell`）。
   - **命令健康校验**：ProgId 名字命中还不够，还要读 `ProgId\shell\open\command`
     取出 exe 路径（兼容带/不带引号），确认文件存在且 basename 与 `process.execPath` 一致。
     应用换过安装目录（如 `D:\Program Files\mk` → `%LOCALAPPDATA%\Programs\mk`）后，
     注册表会残留旧路径，只比名字会误判为「已默认」，实际双击打不开。
   - **ProgId 形式**：Win11 在「打开方式」里选中本应用后，`UserChoice` 里记录的可能是
     `Applications\<exe 名>` 而非 ProgId 名，`isOwnProgId` 一并识别。
   - **自愈**：`ensureOwnRegistration()` 在启动/聚焦复查与一键设置前，把两个自有 ProgId
     （`Markdown Document`、历史别名 `mkdown.md`）的 open 命令与 DefaultIcon 重写到当前
     `process.execPath`，但不改变用户选择的默认程序。
   - 检测结果决定工具栏按钮与菜单项：未默认时显示「设为默认应用」，成功后隐藏 / 菜单项变为
     禁用的「已是 Markdown 默认应用」。窗口获得焦点时（3 秒节流）复查一次，
     用户在系统设置 / Finder 里改过默认也能及时同步。
5. **文件图标**：`ProgId\DefaultIcon` 必须写成 `"<exe 全路径>",0`——引号只包住路径，
   图标索引放在引号外。写成 `"<exe 全路径>,0"`（把 `,0` 也括进去）会被 shell 当成一个
   不存在的文件名，静默回落到通用空白文档图标，且注册表查询看起来完全正常，极难排查。
   修改后需 `ie4uinit.exe -ClearIconCache` + `-show` 并广播 `SHChangeNotify`，
   资源管理器里按 F5 即可看到新图标。

文件传入路径的处理：

- 启动参数：主进程解析 `process.argv` 中的 Markdown 文件路径，作为首个窗口的初始文档。
- 运行中双击：Windows 走 `second-instance` 的 argv；macOS 走 `app.on('open-file')`。
  两者都经 `openPathInWindow`：文件已在某窗口打开则聚焦该窗口，否则新开窗口加载它。
- 任务栏「新建窗口」：argv 带 `--new-window`，直接新开空白窗口。
- 渲染器拖拽：Electron 新版要求用 `webUtils.getPathForFile(file)` 取真实路径（preload 暴露）。

## 6. 目录结构

```
mkdown/
├── agent.md                  # 本指南
├── build/icon.ico            # 高清应用图标（16~256px，安装/文件图标同用）
├── scripts/generate-icon.mjs # 图标生成脚本（sharp：SVG → 多尺寸 ICO）
├── package.json              # 依赖 + electron-builder 打包配置
├── electron.vite.config.ts   # main / preload / renderer 三段构建
├── tsconfig.json
└── src/
    ├── main/index.ts         # 窗口、菜单、文件 IO、注册表、IPC
    ├── preload/index.ts      # contextBridge API（含类型导出）
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx      # React 入口
            ├── App.tsx       # 状态、工具栏、编辑/预览布局、关闭保护
            ├── Preview.tsx   # react-markdown 渲染（GFM/KaTeX/highlight）
            ├── env.d.ts      # window.api 类型
            └── styles.css
```

## 7. 常用命令

```bash
npm install        # 安装依赖（国内可加 --registry=https://registry.npmmirror.com）
npm run dev        # 开发模式（热更新）
npm run typecheck  # TypeScript 类型检查
npm run build      # 产物输出到 out/
npm run dist       # 生成 Windows NSIS 安装包到 release/（含 .md 文件关联）
node scripts/generate-icon.mjs  # 重新生成 build/icon.ico 与 icon.png
```

## 8. Markdown 渲染管线

`react-markdown`（CommonMark）+ `remark-gfm`（表格/任务列表/删除线/脚注/自动链接）
+ `remark-breaks`（单换行即换行、空行分段）+ `remark-math` / `rehype-katex`（数学公式）
+ `rehype-highlight`（代码高亮，自动检测语言，`plainText: ['mermaid']` 排除 mermaid 块）。
原始 HTML（如从网页/Word 复制的 `<table>`）先由 `rehype-raw` 解析为真实节点，
再经 `rehype-sanitize`（GitHub 风格默认 schema + 少量放行）过滤 `<script>`、事件属性与危险协议；
schema 需注意两点：`clobberPrefix: ''`（脚注 id 已由 remark 加过前缀，重复加会导致锚点失效），
以及同一属性的候选值必须写在同一条规则里（sanitize 只取第一条 className 规则）——
`code` 放行 `math-inline/math-display`（公式节点是 `<code class="language-math ...">`）、
`h2` 放行 `footnotes-title`。`rehype-sanitize` 必须排在 katex/highlight 之前，
否则它们生成的 class 会被一并清掉。mermaid 围栏代码块由 `pre` 组件拦截，
交给 `mermaid.render` 生成 SVG（300ms 防抖、`securityLevel: 'strict'`、唯一 id）；
语法错误时显示错误提示并保留上一次成功图形；在编辑器中修改代码块即实时重渲染。
预览中的链接点击交给系统浏览器；本地图片（相对路径、绝对路径、`file://`）统一改写为
`mkimg://img/?p=<绝对路径>`，由主进程校验存在性后读盘返回，开发模式也能显示。编辑器内粘贴图片
（剪贴板位图或资源管理器复制的图片文件）会先落盘到文档旁 `assets/`，再于光标处插入 `![](assets/...)`；
文档未保存时落到 `userData/pasted-images` 并插入绝对路径。纯预览模式下粘贴则追加到文末。
连续空行会被 CommonMark 折叠成一个段落间隔，`remarkBlankLines` 按源码行号在顶层块之间
插入 `<div class="md-blank">` 占位块（每个多出的空行一块，CSS 高度 `1lh`）还原留白。

脚注（GFM）：`remarkRehypeOptions` 把区块标题汉化为「脚注」（`footnotes-title`，默认为隐藏的 `sr-only`）、
返回链接 aria-label 设为「返回正文」。注意两点：一是只有正文中出现真实 `[^x]` 引用才会生成脚注区块，
写在行内代码里的 `` `[^1]` `` 不算引用，孤立的定义会被直接丢弃；二是 `a` 组件统一 `preventDefault`，
因此 `#` 开头的页内锚点必须自行处理——`jumpToAnchor` 在预览容器内按 id 定位、`scrollIntoView` 居中
并加 1.2s `anchor-flash` 高亮。这里不用 `behavior: 'smooth'`：窗口不可见时 Chromium 会暂停平滑滚动动画，
导致跳转静默失效。重复点击同一目标时先移除 class、读一次 `offsetWidth` 强制重排再添加，动画才会重播。

脚注徽章尺寸：`sup` 自带一次缩小，若 `a[data-footnote-ref]` 再用 `em` 就会叠缩到 10px（实测 10×13px，
既看不清也点不中）。因此 `.markdown-body sup` 只负责上移（`font-size: 1em; line-height: 0; top: -0.5em`），
徽章本身用固定 `font-size: 12px` + 内边距 + `::before/::after` 补出 `[` `]`，实测 24×19px。

自定义组件必须剔除 `node`：react-markdown 会把 hast 节点作为 `node` prop 传进来，
若直接 `{...props}` 展开就会在 DOM 上渲染出非法属性 `node="[object Object]"`。
`a` / `img` 均先解构出 `node` 再展开其余 props。

编辑器布局注意：`@uiw/react-codemirror` 的 `height="100%"` 只写进 CodeMirror 主题（作用于 `.cm-editor`），
不会设置外层包裹 `div.cm-theme-light` 的高度。若包裹层高度为 `auto`，`.cm-editor` / `.cm-scroller` 的
百分比高度会退化成内容高度，编辑器被整体撑开且无法滚动。因此 `.editor-pane` 设为
`display: flex; overflow: hidden`，并用 `.editor-pane > * { flex: 1; min-height: 0 }` 让包裹层撑满，
滚动始终由内部 `.cm-scroller` 承担。

文本选中：`user-select: none` 只能加在界面外壳（`.toolbar` / `.statusbar` / `.modal`），
绝不能加在 `body` 上——它会一路继承到 `.cm-content`，使编辑区鼠标拖动选择完全失效
（实测选区长度为 0、`.cm-selectionBackground` 数量为 0）。`.editor-pane` 显式声明 `user-select: text`。
另外 basicSetup 默认启用 `drawSelection()`，选区由 CodeMirror 自绘，必须给
`.cm-selectionBackground` 显式配色（用 `!important` 压过 CM 主题的更高特异性），否则选中几乎看不见。

## 9. 已知限制

- 开发模式（electron 未打包）不执行默认应用注册，按钮会提示使用安装版。
- 开发模式下任务栏「最近」项点击后可能无法正确启动应用（系统按 AUMID 拉起的是
  electron.exe 而非应用入口），应用内「打开」下拉不受影响；打包安装后正常。
- ~~开发模式下文档内相对路径本地图片可能不显示（webSecurity）~~：现已改走 `mkimg://` 协议，
  开发与打包模式都能显示；仅当页面被外部地址接管（非同源 iframe）时才可能受限。
- 若旧 UserChoice / UserChoiceLatest 受系统保护无法删除，Windows 自动默认设置会失败，
  需用户在 Windows 设置 → 默认应用中手动选择一次（兜底路径）。
- macOS 的默认应用设置走 LaunchServices，若应用不在 /Applications、或系统未把本应用
  登记为 `.md` 的处理程序，`LSSetDefaultRoleHandlerForContentType` 可能不生效，
  需用 Finder「显示简介 → 全部更改」手动设置（兜底路径）。
