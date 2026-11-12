import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { Preview } from './Preview'
import type { UpdateEvent } from '../../preload'

type ViewMode = 'edit' | 'split' | 'preview'

const MD_FILE_RE = /\.(md|markdown|mdown|mkd)$/i

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
  '> 提示：点击工具栏右侧「设为 .md 默认应用」可一键将本应用设为 Markdown 文件的默认打开方式（安装版），设置成功后按钮自动隐藏。',
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
  chevronDown: 'M6 9l6 6 6-6'
}

export default function App() {
  const [content, setContent] = useState(WELCOME)
  const [savedContent, setSavedContent] = useState(WELCOME)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [status, setStatus] = useState('就绪')
  const [busy, setBusy] = useState(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [showDefaultButton, setShowDefaultButton] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const recentRef = useRef<HTMLDivElement>(null)
  const [update, setUpdate] = useState<UpdateEvent>({ type: 'idle' })
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)

  const dirty = content !== savedContent

  // 事件回调中读取最新状态，避免闭包过期
  const stateRef = useRef({ content, filePath, dirty })
  stateRef.current = { content, filePath, dirty }

  const cmExtensions = useMemo(() => [markdown()], [])

  const loadDocument = useCallback((path: string, text: string) => {
    setContent(text)
    setSavedContent(text)
    setFilePath(path)
    setStatus(`已打开 ${baseName(path)}`)
  }, [])

  const confirmDiscard = useCallback((message: string): boolean => {
    return !stateRef.current.dirty || window.confirm(message)
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

  const setDefault = useCallback(async (): Promise<void> => {
    const result = await window.api.setDefaultApp()
    setStatus(result.message)
    if (result.ok) {
      setShowDefaultButton(!(await window.api.getDefaultState()))
    } else {
      window.alert(result.message)
    }
  }, [])

  const doCheckUpdate = useCallback(async (): Promise<void> => {
    setStatus('正在检查更新…')
    const result = await window.api.checkUpdate()
    if (!result.ok) setStatus(`检查更新失败：${result.message}`)
    else if (result.status === 'not-available') setStatus('当前已是最新版本')
    else setStatus(`发现新版本 v${result.version}`)
  }, [])

  const doDownloadUpdate = useCallback(async (): Promise<void> => {
    setUpdateBusy(true)
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
        case 'view-edit':
          setViewMode('edit')
          break
        case 'view-split':
          setViewMode('split')
          break
        case 'view-preview':
          setViewMode('preview')
          break
        case 'set-default':
          void setDefault()
          break
        case 'check-update':
          void doCheckUpdate()
          break
      }
    },
    [doOpen, doSave, doSaveAs, setDefault, doCheckUpdate]
  )

  // 订阅主进程事件 + 读取启动时传入的文件
  useEffect(() => {
    const offMenu = window.api.onMenuAction(handleMenuAction)
    const offClose = window.api.onCloseRequested(() => setCloseDialogOpen(true))
    void window.api.getInitialFile().then((r) => {
      if (r && r.ok) loadDocument(r.path, r.content)
    })
    void window.api.getDefaultState().then((isDefault) => setShowDefaultButton(!isDefault))
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
        <div className="toolbar-group toolbar-right">
          {showDefaultButton && (
            <button
              className="ghost"
              onClick={() => void setDefault()}
              title="一键将本应用设为 .md 文件的默认打开方式"
            >
              设为 .md 默认应用
            </button>
          )}
        </div>
      </header>

      <main className={`workspace mode-${viewMode}`}>
        {viewMode !== 'preview' && (
          <section className="pane editor-pane" aria-label="Markdown 编辑器">
            <CodeMirror
              value={content}
              height="100%"
              extensions={cmExtensions}
              onChange={(v) => setContent(v)}
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
          <section className="pane preview-pane" aria-label="Markdown 预览">
            <Preview content={content} filePath={filePath} />
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
        <span className="status-path" title={filePath ?? undefined}>
          {filePath ?? '未命名文档'}
          {dirty && <span className="dirty-flag"> ● 未保存</span>}
        </span>
        <span className="status-message">{status}</span>
        <span className="status-meta">
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
