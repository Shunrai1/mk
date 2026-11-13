import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { EditorState, type EditorView } from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { openSearchPanel, search } from '@codemirror/search'
import { Preview } from './Preview'
import { Toc } from './Toc'
import type { ImageSaveResult, Theme, UpdateEvent } from '../../preload'

type ViewMode = 'edit' | 'split' | 'preview'

// 主进程经 URL query 传入当前主题，模块加载时立即应用，避免首帧闪烁
const queryTheme = new URLSearchParams(window.location.search).get('theme')
const initialTheme: Theme = queryTheme === 'dark' || queryTheme === 'grid' ? queryTheme : 'light'
document.documentElement.dataset.theme = initialTheme

const MD_FILE_RE = /\.(md|markdown|mdown|mkd)$/i
const SYNC_STORE_KEY = 'mkdown.sync-scroll'

// 剪贴板图片 MIME → 落盘扩展名
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif'
}
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : ''
}

const WELCOME = [
  '# 欢迎使用 Markdown 笔记本',
  '',
  '基于 **Electron + React + TypeScript** 的桌面 Markdown 笔记本。',
  '',
  '## 快速上手',
  '',
  '- `Ctrl + O` 打开 `.md` 文件，也可以直接把文件拖进窗口',
  '- `Ctrl + S` 保存，`Ctrl + Shift + S` 另存为',
  '- `Ctrl + 1 / 2 / 3` 切换 编辑 / 分屏 / 预览 模式',
  '- `Ctrl + F` 查找（编辑区与预览区均支持）',
  '- 菜单「视图 → 主题」可切换 明亮 / 暗黑 / 网格 三种主题',
  '',
  '## 支持的语法',
  '',
  '### GFM 扩展',
  '',
  '| 功能 | 语法示例 | 状态 |',
  '| ---- | ---- | ---- |',
  '| 表格 | `\\| a \\| b \\|` | 支持 |',
  '| 任务列表 | `- [x] 已完成` | 支持 |',
  '| 删除线 | `~~文本~~` | 支持 |',
  '| 脚注 | `文本[^1]` | 支持 |',
  '',
  '- [x] CommonMark 标准语法',
  '- [x] GitHub Flavored Markdown',
  '- [ ] 试着在左侧编辑这一行',
  '',
  '脚注示例：点击上标[^1]会跳到文末脚注，再点脚注末尾的 ↩ 可以跳回来；同一篇文档支持多个脚注[^2]。',
  '',
  '### 代码高亮',
  '',
  '```ts',
  'function greet(name: string): string {',
  '  return "你好, " + name',
  '}',
  '```',
  '',
  '### 数学公式（KaTeX）',
  '',
  '行内公式 $E = mc^2$，块级公式：',
  '',
  '$$',
  '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
  '$$',
  '',
  '### Mermaid 图表',
  '',
  '```mermaid',
  'graph LR',
  '  A[编写 Markdown] --> B{实时预览}',
  '  B --> C[CodeMirror 编辑]',
  '  B --> D[渲染图表与公式]',
  '```',
  '',
  '> 提示：菜单「帮助 → 设为 Markdown 默认应用」可一键将本应用设为 Markdown 文件的默认打开方式（安装版）。',
  '',
  '[^1]: 这是一个脚注。',
  '[^2]: 第二个脚注，编号按正文中首次引用的顺序排列。',
  ''
].join('\n')

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  close: 'M18 6L6 18M6 6l12 12',
  sync: 'M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4'
}

export default function App() {
  const [content, setContent] = useState(WELCOME)
  const [savedContent, setSavedContent] = useState(WELCOME)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [syncScroll, setSyncScroll] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SYNC_STORE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [status, setStatus] = useState('就绪')
  const [busy, setBusy] = useState(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const recentRef = useRef<HTMLDivElement>(null)
  const [update, setUpdate] = useState<UpdateEvent>({ type: 'idle' })
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)

  // Ctrl+F 查找：编辑区用 CodeMirror 搜索面板，预览区用自定义查找条
  const cmViewRef = useRef<EditorView | null>(null)
  const activePaneRef = useRef<'editor' | 'preview'>('editor')
  const previewInputRef = useRef<HTMLInputElement>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const previewRootRef = useRef<HTMLDivElement>(null)
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false)
  const [previewQuery, setPreviewQuery] = useState('')
  const [previewCase, setPreviewCase] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewCount, setPreviewCount] = useState(0)

  const dirty = content !== savedContent

  // 主题：主进程为唯一来源（持久化 + 多窗口同步），本地即时应用保证反馈
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    let mounted = true
    void window.api.getTheme().then((t) => {
      if (mounted) setTheme(t)
    })
    const off = window.api.onThemeChanged(setTheme)
    return () => {
      mounted = false
      off()
    }
  }, [])

  // 同步滚动偏好持久化
  useEffect(() => {
    try {
      localStorage.setItem(SYNC_STORE_KEY, syncScroll ? '1' : '0')
    } catch {
      // 隐私模式等写入失败时忽略，仅影响偏好记忆
    }
  }, [syncScroll])

  // 分屏同步滚动：编辑区与预览区按滚动比例双向联动。
  // 程序写入的目标位置会被记录下来，用于过滤自身触发的 scroll 事件，避免两边互相追逐。
  useEffect(() => {
    if (viewMode !== 'split' || !syncScroll) return
    const editor = cmViewRef.current?.scrollDOM
    const preview = previewScrollRef.current
    if (!editor || !preview) return

    const programmatic = { editor: Number.NaN, preview: Number.NaN }
    const ratioOf = (el: HTMLElement): number => {
      const max = el.scrollHeight - el.clientHeight
      return max > 0 ? el.scrollTop / max : 0
    }
    const apply = (el: HTMLElement, ratio: number): number => {
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.max(0, Math.min(max, ratio * max))
      return el.scrollTop
    }

    const onEditorScroll = (): void => {
      if (editor.scrollTop === programmatic.editor) return
      programmatic.preview = apply(preview, ratioOf(editor))
    }
    const onPreviewScroll = (): void => {
      if (preview.scrollTop === programmatic.preview) return
      programmatic.editor = apply(editor, ratioOf(preview))
    }

    editor.addEventListener('scroll', onEditorScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })
    // 开启开关或进入分屏时，先把预览对齐到编辑区当前位置
    programmatic.preview = apply(preview, ratioOf(editor))
    return () => {
      editor.removeEventListener('scroll', onEditorScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
    }
  }, [viewMode, syncScroll])

  // 事件回调中读取最新状态，避免闭包过期
  const stateRef = useRef({ content, filePath, dirty })
  stateRef.current = { content, filePath, dirty }

  const cmExtensions = useMemo(
    () => [
      markdown(),
      search({ top: true }),
      EditorState.phrases.of({
        Find: '查找',
        Replace: '替换',
        next: '下一个',
        previous: '上一个',
        all: '全选',
        'match case': '区分大小写',
        regexp: '正则',
        'by word': '全词匹配',
        replace: '替换',
        'replace all': '全部替换',
        close: '关闭',
        'current match': '当前匹配',
        'on line': '位于行',
        'replaced $ matches': '已替换 $ 处匹配',
        'replaced match on line $': '已替换第 $ 行的匹配'
      })
    ],
    []
  )

  const loadDocument = useCallback((path: string, text: string) => {
    setContent(text)
    setSavedContent(text)
    setFilePath(path)
    setStatus(`已打开 ${baseName(path)}`)
  }, [])

  const confirmDiscard = useCallback((message: string): boolean => {
    return !stateRef.current.dirty || window.confirm(message)
  }, [])

  // 在编辑器光标处插入 Markdown；编辑器未挂载（纯预览模式）时追加到文末
  const insertMarkdown = useCallback((text: string): void => {
    const view = cmViewRef.current
    if (view && view.dom.isConnected) {
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true
      })
      view.focus()
      return
    }
    setContent((prev) => `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${text}`)
  }, [])

  const doSave = useCallback(async (): Promise<boolean> => {
    const { content: text, filePath: p } = stateRef.current
    setBusy(true)
    try {
      const result = p
        ? await window.api.saveFile(p, text)
        : await window.api.saveFileAs(text)
      if (result.ok) {
        setFilePath(result.path)
        setSavedContent(text)
        setStatus(`已保存 · ${new Date().toLocaleTimeString()}`)
        return true
      }
      if (result.error) setStatus(`保存失败：${result.error}`)
      return false
    } catch (err) {
      setStatus(`保存失败：${(err as Error).message}`)
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const doSaveAs = useCallback(async (): Promise<void> => {
    const { content: text, filePath: p } = stateRef.current
    setBusy(true)
    try {
      const result = await window.api.saveFileAs(text, p ?? undefined)
      if (result.ok) {
        setFilePath(result.path)
        setSavedContent(text)
        setStatus(`已另存为 ${baseName(result.path)}`)
      } else if (result.error) {
        setStatus(`保存失败：${result.error}`)
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const doOpen = useCallback(async (): Promise<void> => {
    if (!confirmDiscard('当前文档有未保存的修改，打开其他文件将丢弃这些修改。继续？')) return
    const result = await window.api.openFile()
    if (result.ok) loadDocument(result.path, result.content)
    else if (result.error) setStatus(`打开失败：${result.error}`)
  }, [confirmDiscard, loadDocument])

  const doNewWindow = useCallback((): void => {
    window.api.newWindow()
  }, [])

  const openExternalPath = useCallback(
    async (path: string): Promise<void> => {
      if (!confirmDiscard('当前文档有未保存的修改，打开新文件将丢弃这些修改。继续？')) return
      const result = await window.api.openPath(path)
      if (result.ok) loadDocument(result.path, result.content)
      else if (result.error) setStatus(`打开失败：${result.error}`)
    },
    [confirmDiscard, loadDocument]
  )

  const toggleRecentMenu = useCallback(async (): Promise<void> => {
    if (recentOpen) {
      setRecentOpen(false)
      return
    }
    setRecentFiles(await window.api.getRecentFiles())
    setRecentOpen(true)
  }, [recentOpen])

  const openRecentFile = useCallback(
    (path: string): void => {
      setRecentOpen(false)
      void openExternalPath(path)
    },
    [openExternalPath]
  )

  const clearRecentFiles = useCallback(async (): Promise<void> => {
    await window.api.clearRecentFiles()
    setRecentFiles([])
  }, [])

  // 最近文件下拉：点击外部或按 Esc 关闭
  useEffect(() => {
    if (!recentOpen) return
    const onMouseDown = (e: MouseEvent): void => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) setRecentOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRecentOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [recentOpen])

  // Ctrl+F：按当前视图与最近交互的窗格决定搜索目标（分屏时跟随焦点所在窗格）
  const openFind = useCallback((): void => {
    const target =
      viewMode === 'preview' ? 'preview' : viewMode === 'edit' ? 'editor' : activePaneRef.current
    if (target === 'editor' && cmViewRef.current) {
      cmViewRef.current.focus()
      openSearchPanel(cmViewRef.current)
    } else {
      setPreviewSearchOpen(true)
    }
  }, [viewMode])

  const closePreviewSearch = useCallback((): void => {
    setPreviewSearchOpen(false)
  }, [])

  const stepPreviewMatch = useCallback(
    (delta: number): void => {
      if (previewCount === 0) return
      setPreviewIndex((i) => (i + delta + previewCount) % previewCount)
    },
    [previewCount]
  )

  // 打开预览查找条时聚焦并选中输入框
  useEffect(() => {
    if (previewSearchOpen) {
      previewInputRef.current?.focus()
      previewInputRef.current?.select()
    }
  }, [previewSearchOpen])

  // 文档变化导致匹配数变化时，收敛当前匹配序号
  useEffect(() => {
    setPreviewIndex((i) => (previewCount === 0 ? 0 : Math.min(i, previewCount - 1)))
  }, [previewCount])

  // 键盘兜底：菜单快捷键未拦截时仍能触发查找；Esc 关闭预览查找条
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
      } else if (e.key === 'Escape' && previewSearchOpen && !cmViewRef.current?.hasFocus) {
        closePreviewSearch()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openFind, previewSearchOpen, closePreviewSearch])

  const doDownloadUpdate = useCallback(async (): Promise<void> => {
    setUpdateBusy(true)
    setStatus('正在下载更新…')
    const result = await window.api.downloadUpdate()
    setUpdateBusy(false)
    if (!result.ok) setStatus(`下载更新失败：${result.message ?? '未知错误'}`)
  }, [])

  const handleMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case 'open':
          void doOpen()
          break
        case 'save':
          void doSave()
          break
        case 'save-as':
          void doSaveAs()
          break
        case 'find':
          openFind()
          break
        case 'view-edit':
          setViewMode('edit')
          break
        case 'view-split':
          setViewMode('split')
          break
        case 'view-preview':
          setViewMode('preview')
          break
      }
    },
    [doOpen, doSave, doSaveAs, openFind]
  )

  // 订阅主进程事件 + 读取启动时传入的文件
  useEffect(() => {
    const offMenu = window.api.onMenuAction(handleMenuAction)
    const offClose = window.api.onCloseRequested(() => setCloseDialogOpen(true))
    void window.api.getInitialFile().then((r) => {
      if (r && r.ok) loadDocument(r.path, r.content)
    })
    return () => {
      offMenu()
      offClose()
    }
  }, [handleMenuAction, loadDocument])

  // 上报脏标记与路径（主进程维护标题与关闭保护）
  useEffect(() => {
    window.api.setDocState({ dirty, path: filePath })
  }, [dirty, filePath])

  // 订阅更新事件；新窗口打开时恢复主进程已有的更新状态
  useEffect(() => {
    const off = window.api.onUpdateEvent((event) => {
      setUpdate(event)
      if (event.type === 'available' || event.type === 'downloaded') setUpdateDismissed(false)
    })
    void window.api.getUpdateState().then(setUpdate)
    return off
  }, [])

  // 拖拽打开
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      const path = window.api.getPathForFile(file)
      if (!path || !MD_FILE_RE.test(path)) {
        setStatus('仅支持 Markdown 文件（.md / .markdown / .mdown / .mkd）')
        return
      }
      void openExternalPath(path)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openExternalPath])

  // 粘贴图片：剪贴板里的位图或图片文件先落盘，再在光标处插入 Markdown 图片语法。
  // 用捕获阶段监听，避免 CodeMirror 先按纯文本处理；普通文本粘贴不受影响。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const data = e.clipboardData
      if (!data) return
      const files: File[] = []
      for (const item of Array.from(data.items)) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file && (file.type.startsWith('image/') || IMAGE_FILE_RE.test(file.name))) {
          files.push(file)
        }
      }
      if (files.length === 0) return
      e.preventDefault()
      e.stopPropagation()

      void (async () => {
        try {
          const docPath = stateRef.current.filePath
          const marks: string[] = []
          let failed = 0
          for (const file of files) {
            const ext =
              IMAGE_EXT_BY_MIME[file.type] ?? file.name.split('.').pop()?.toLowerCase() ?? 'png'
            let source = ''
            try {
              source = window.api.getPathForFile(file)
            } catch {
              source = ''
            }
            // 资源管理器复制来的文件优先直接复制；失败（如临时文件无扩展名）再回退到字节写入
            let result: ImageSaveResult | null = source
              ? await window.api.importImageFile(source, docPath)
              : null
            if (!result || !result.ok) {
              result = await window.api.savePastedImage(await file.arrayBuffer(), ext, docPath)
            }
            if (result.ok) marks.push(`![粘贴的图片](${result.path})`)
            else failed += 1
          }
          if (marks.length > 0) {
            insertMarkdown(marks.join('\n'))
            setStatus(
              docPath
                ? `已插入 ${marks.length} 张图片，保存在文档旁的 assets 目录${failed ? `（${failed} 张失败）` : ''}`
                : `已插入 ${marks.length} 张图片，暂存于应用数据目录，建议先保存文档${failed ? `（${failed} 张失败）` : ''}`
            )
          } else {
            setStatus('插入图片失败：无法读取剪贴板中的图片')
          }
        } catch (err) {
          setStatus(`插入图片失败：${(err as Error).message}`)
        }
      })()
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [insertMarkdown])

  const closeAndSave = async (): Promise<void> => {
    const ok = await doSave()
    if (ok) {
      setCloseDialogOpen(false)
      window.api.forceClose()
    }
  }

  const viewLabels: Record<ViewMode, string> = { edit: '编辑', split: '分屏', preview: '预览' }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-group">
          <button onClick={doNewWindow} title="新建窗口 (Ctrl+N)">
            <Icon d={ICONS.plus} />
            <span>新建</span>
          </button>
          <div className="open-split" ref={recentRef}>
            <button onClick={() => void doOpen()} title="打开 (Ctrl+O)">
              <Icon d={ICONS.folder} />
              <span>打开</span>
            </button>
            <button
              className="open-caret"
              onClick={() => void toggleRecentMenu()}
              title="最近打开的文件"
              aria-haspopup="menu"
              aria-expanded={recentOpen}
            >
              <Icon d={ICONS.chevronDown} />
            </button>
            {recentOpen && (
              <div className="recent-menu" role="menu" aria-label="最近打开的文件">
                <div className="recent-title">最近打开</div>
                {recentFiles.length === 0 ? (
                  <div className="recent-empty">暂无最近打开的文件</div>
                ) : (
                  recentFiles.map((p) => (
                    <button
                      key={p}
                      role="menuitem"
                      className="recent-item"
                      title={p}
                      onClick={() => openRecentFile(p)}
                    >
                      <span className="recent-name">{baseName(p)}</span>
                      <span className="recent-dir">{dirName(p)}</span>
                    </button>
                  ))
                )}
                <div className="recent-actions">
                  <button
                    onClick={() => {
                      setRecentOpen(false)
                      void doOpen()
                    }}
                  >
                    打开文件…
                  </button>
                  <button onClick={() => void clearRecentFiles()} disabled={recentFiles.length === 0}>
                    清空记录
                  </button>
                </div>
              </div>
            )}
          </div>
          <button onClick={() => void doSave()} disabled={busy} title="保存 (Ctrl+S)">
            <Icon d={ICONS.save} />
            <span>{busy ? '保存中…' : '保存'}</span>
          </button>
          <button onClick={() => void doSaveAs()} disabled={busy} title="另存为 (Ctrl+Shift+S)">
            <span>另存为</span>
          </button>
        </div>
        <div className="toolbar-group view-switch" role="tablist" aria-label="视图模式">
          {(Object.keys(viewLabels) as ViewMode[]).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={viewMode === mode}
              className={viewMode === mode ? 'active' : ''}
              onClick={() => setViewMode(mode)}
            >
              {viewLabels[mode]}
            </button>
          ))}
        </div>
        {viewMode === 'split' && (
          <div className="toolbar-group">
            <button
              className={`sync-toggle${syncScroll ? ' active' : ''}`}
              aria-pressed={syncScroll}
              title={
                syncScroll
                  ? '关闭同步滚动'
                  : '开启同步滚动：编辑区与预览区按相同比例一起滚动'
              }
              onClick={() => setSyncScroll((v) => !v)}
            >
              <Icon d={ICONS.sync} />
              <span>同步滚动</span>
            </button>
          </div>
        )}
      </header>

      <main className={`workspace mode-${viewMode}`}>
        {viewMode !== 'preview' && (
          <section
            className="pane editor-pane"
            aria-label="Markdown 编辑器"
            onMouseDownCapture={() => (activePaneRef.current = 'editor')}
            onFocusCapture={() => (activePaneRef.current = 'editor')}
          >
            <CodeMirror
              value={content}
              height="100%"
              theme={theme === 'dark' ? 'dark' : 'light'}
              extensions={cmExtensions}
              onChange={(v) => setContent(v)}
              onCreateEditor={(view) => (cmViewRef.current = view)}
              placeholder="开始输入 Markdown…"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                autocompletion: false
              }}
            />
          </section>
        )}
        {viewMode !== 'edit' && (
          <section
            className="pane preview-pane"
            aria-label="Markdown 预览"
            onMouseDownCapture={() => (activePaneRef.current = 'preview')}
            onFocusCapture={() => (activePaneRef.current = 'preview')}
          >
            <div className="preview-main">
              {previewSearchOpen && (
                <div className="preview-search-bar" role="search" aria-label="在预览中查找">
                  <input
                    ref={previewInputRef}
                    value={previewQuery}
                    placeholder="在预览中查找"
                    aria-label="查找内容"
                    onChange={(e) => {
                      setPreviewQuery(e.target.value)
                      setPreviewIndex(0)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        stepPreviewMatch(e.shiftKey ? -1 : 1)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        closePreviewSearch()
                      }
                    }}
                  />
                  <span className="preview-search-count" aria-live="polite">
                    {previewQuery
                      ? previewCount > 0
                        ? `${Math.min(previewIndex + 1, previewCount)}/${previewCount}`
                        : '无结果'
                      : ''}
                  </span>
                  <button
                    className={`case-toggle${previewCase ? ' active' : ''}`}
                    title="区分大小写"
                    aria-pressed={previewCase}
                    onClick={() => {
                      setPreviewCase((v) => !v)
                      setPreviewIndex(0)
                    }}
                  >
                    Aa
                  </button>
                  <button
                    title="上一个 (Shift+Enter)"
                    onClick={() => stepPreviewMatch(-1)}
                    disabled={previewCount === 0}
                  >
                    <Icon d={ICONS.chevronUp} />
                  </button>
                  <button
                    title="下一个 (Enter)"
                    onClick={() => stepPreviewMatch(1)}
                    disabled={previewCount === 0}
                  >
                    <Icon d={ICONS.chevronDown} />
                  </button>
                  <button title="关闭 (Esc)" onClick={closePreviewSearch}>
                    <Icon d={ICONS.close} />
                  </button>
                </div>
              )}
              <div className="preview-scroll" ref={previewScrollRef}>
                <Preview
                  content={content}
                  filePath={filePath}
                  rootRef={previewRootRef}
                  theme={theme}
                  searchActive={previewSearchOpen}
                  searchQuery={previewQuery}
                  searchCaseSensitive={previewCase}
                  searchIndex={previewIndex}
                  onSearchCount={setPreviewCount}
                />
              </div>
            </div>
            <Toc content={content} rootRef={previewRootRef} scrollRef={previewScrollRef} />
          </section>
        )}
      </main>

      {update.type !== 'idle' && !updateDismissed && (
        <div className="update-banner" role="status">
          {update.type === 'available' && (
            <>
              <span className="update-text">发现新版本 v{update.version}</span>
              <div className="update-actions">
                <button
                  className="primary"
                  onClick={() => void doDownloadUpdate()}
                  disabled={updateBusy}
                >
                  {updateBusy ? '准备下载…' : '立即更新'}
                </button>
                <button onClick={() => setUpdateDismissed(true)}>稍后</button>
              </div>
            </>
          )}
          {update.type === 'progress' && (
            <>
              <span className="update-text">正在下载新版本… {update.percent}%</span>
              <div className="update-progress">
                <div className="update-progress-fill" style={{ width: `${update.percent}%` }} />
              </div>
            </>
          )}
          {update.type === 'downloaded' && (
            <>
              <span className="update-text">新版本 v{update.version} 已就绪</span>
              <div className="update-actions">
                <button className="primary" onClick={() => window.api.installUpdate()}>
                  重启安装
                </button>
                <button onClick={() => setUpdateDismissed(true)}>稍后</button>
              </div>
            </>
          )}
        </div>
      )}

      <footer className="statusbar">
        <span
          className="status-path"
          title={filePath ? `${filePath}（当前打开的 Markdown 文件）` : '尚未保存到文件，按 Ctrl+S 可保存'}
        >
          {filePath ?? '未命名文档'}
          {dirty && <span className="dirty-flag"> ● 未保存</span>}
        </span>
        <span className="status-message" title="操作状态提示：打开、保存、检查更新等结果会显示在这里">
          {status}
        </span>
        <span className="status-meta" title="当前文档的字符数与行数">
          {content.length} 字符 · {content.split('\n').length} 行 · Markdown
        </span>
      </footer>

      {closeDialogOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="保存确认">
          <div className="modal">
            <h3>要保存修改吗？</h3>
            <p>文档「{filePath ? baseName(filePath) : '未命名'}」有未保存的修改。</p>
            <div className="modal-actions">
              <button className="primary" onClick={() => void closeAndSave()} disabled={busy}>
                {busy ? '保存中…' : '保存并关闭'}
              </button>
              <button
                onClick={() => {
                  setCloseDialogOpen(false)
                  window.api.forceClose()
                }}
              >
                不保存
              </button>
              <button onClick={() => setCloseDialogOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
