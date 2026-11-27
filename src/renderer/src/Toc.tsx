/** 显示 Markdown 标题目录，定位并展开预览中的目标章节。 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react'
import { flashAnchor, revealFoldedSections } from './Preview'

interface TocHeading {
  id: string
  text: string
  level: number
}

interface RailItem {
  id: string
  frac: number
}

// 缩略横线宽度随标题层级递减，当前标题额外加长并着色
const DASH_WIDTH: Record<number, number> = { 1: 22, 2: 18, 3: 14, 4: 11, 5: 9, 6: 9 }
const STORE_KEY = 'mkdown.toc.pinned'

/** 将标题文本转换为稳定的页内锚点。 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** 读取是否固定显示目录的偏好。 */
function readPinned(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1'
  } catch {
    return false
  }
}

/** 渲染目录控件使用的装饰图标。 */
function TocIcon({ d }: { d: string }) {
  return (
    <svg
      width="14"
      height="14"
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
  list: 'M4 6h16M4 12h10M4 18h7',
  pin: 'M9 4h6v6l3 3v1H6v-1l3-3zM12 14v6',
  pinOff: 'M9 4h6v6l3 3v1H6v-1l3-3zM12 14v6M4 4l16 16',
  close: 'M18 6L6 18M6 6l12 12'
}

/** 预览区右侧目录：固定显示为面板；隐藏时收为贴滚动条的缩略横线栏，
    悬停横线栏临时展开面板，点击图钉固定。横线按标题在文档中的位置比例排布。 */
export function Toc({
  content,
  rootRef,
  scrollRef
}: {
  content: string
  rootRef: RefObject<HTMLDivElement>
  scrollRef: RefObject<HTMLDivElement>
}) {
  const [headings, setHeadings] = useState<TocHeading[]>([])
  const [rail, setRail] = useState<RailItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [pinned, setPinned] = useState(readPinned)
  const [expanded, setExpanded] = useState(false)
  const elsRef = useRef<Map<string, HTMLElement>>(new Map())
  const listRef = useRef<HTMLDivElement>(null)
  const expandTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(expandTimer.current), [])

  // 渲染后提取标题并写入锚点 id（跳过脚注区标题），供目录与页内锚点共用
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const els = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).filter(
      (el) => !el.closest('.footnotes')
    )
    const seen = new Map<string, number>()
    const next = els.map((el) => {
      const text = (el.textContent ?? '').trim()
      const base = slugify(text) || 'section'
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      const id = n === 0 ? base : `${base}-${n}`
      el.id = id
      return { id, text, level: Number(el.tagName.charAt(1)) }
    })
    elsRef.current = new Map(next.map((h, i) => [h.id, els[i]]))
    setHeadings(next)
  }, [content, rootRef])

  /** 根据可见标题在文档中的位置更新缩略栏横线。 */
  const measure = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || scroll.scrollHeight === 0) return
    const viewTop = scroll.getBoundingClientRect().top
    const total = scroll.scrollHeight
    setRail(
      headings.flatMap((h) => {
        const el = elsRef.current.get(h.id)
        if (!el?.getClientRects().length) return []
        const docTop = el.getBoundingClientRect().top - viewTop + scroll.scrollTop
        return [{ id: h.id, frac: Math.min(1, Math.max(0, docTop / total)) }]
      })
    )
  }, [headings, scrollRef])

  /** 标记最后一个越过视口上缘的可见标题。 */
  const updateActive = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || headings.length === 0) return
    const threshold = scroll.getBoundingClientRect().top + 90
    let current = ''
    let lastVisible = ''
    for (const h of headings) {
      const el = elsRef.current.get(h.id)
      if (!el?.getClientRects().length) continue
      lastVisible = h.id
      if (!current || el.getBoundingClientRect().top <= threshold) current = h.id
    }
    if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4) {
      current = lastVisible
    }
    setActiveId(current)
  }, [headings, scrollRef])

  useLayoutEffect(() => {
    measure()
    updateActive()
  }, [measure, updateActive])

  // 折叠章节或图片、图表改变文档布局时重测横线位置。
  useEffect(() => {
    const scroll = scrollRef.current
    const root = rootRef.current
    if (!scroll || !root) return
    let raf = 0
    /** 合并同一帧内的布局变化和章节折叠事件。 */
    const remeasure = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        measure()
        updateActive()
      })
    }
    const ro = new ResizeObserver(remeasure)
    ro.observe(scroll)
    ro.observe(root)
    root.addEventListener('toggle', remeasure, true)
    return () => {
      ro.disconnect()
      root.removeEventListener('toggle', remeasure, true)
      cancelAnimationFrame(raf)
    }
  }, [measure, updateActive, rootRef, scrollRef])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let raf = 0
    /** 在浏览器绘制前刷新当前标题。 */
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(updateActive)
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [updateActive, scrollRef])

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, pinned ? '1' : '0')
    } catch {
      // 隐私模式等写入失败时忽略，仅影响偏好记忆
    }
  }, [pinned])

  // 面板可见时让当前标题保持可见
  useEffect(() => {
    if (!pinned && !expanded) return
    listRef.current?.querySelector('.toc-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [activeId, pinned, expanded])

  /** 展开并定位目录中的目标标题，再短暂高亮。 */
  const jump = useCallback(
    (id: string): void => {
      const scroll = scrollRef.current
      const el = elsRef.current.get(id)
      if (scroll && el) {
        revealFoldedSections(el)
        const top =
          el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
        scroll.scrollTop = Math.max(0, top - 12)
      }
      flashAnchor(rootRef.current, id)
      setActiveId(id)
      if (!pinned) setExpanded(false)
    },
    [pinned, rootRef, scrollRef]
  )

  const panel = (
    <>
      <div className="toc-header">
        <TocIcon d={ICONS.list} />
        <span className="toc-title">目录</span>
        <span className="toc-count">{headings.length}</span>
        <div className="toc-actions">
          {pinned ? (
            <button title="隐藏目录，收为缩略栏" onClick={() => setPinned(false)}>
              <TocIcon d={ICONS.pinOff} />
            </button>
          ) : (
            <>
              <button
                title="固定显示目录"
                onClick={() => {
                  setPinned(true)
                  setExpanded(false)
                }}
              >
                <TocIcon d={ICONS.pin} />
              </button>
              <button title="收起" onClick={() => setExpanded(false)}>
                <TocIcon d={ICONS.close} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="toc-list" ref={listRef}>
        {headings.length === 0 ? (
          <div className="toc-empty">文档暂无标题</div>
        ) : (
          headings.map((h) => (
            <button
              key={h.id}
              className={`toc-item${h.id === activeId ? ' active' : ''}`}
              style={{ paddingLeft: 8 + (h.level - 1) * 13 }}
              title={h.text}
              onClick={() => jump(h.id)}
            >
              {h.text}
            </button>
          ))
        )}
      </div>
    </>
  )

  if (pinned) {
    return (
      <nav className="toc pinned" aria-label="文档目录">
        {panel}
      </nav>
    )
  }

  if (headings.length === 0) return null

  return (
    <div
      className={`toc collapsed${expanded ? ' expanded' : ''}`}
      onMouseEnter={() => {
        // 短暂停留先显示标题气泡，悬停稍久再展开面板
        window.clearTimeout(expandTimer.current)
        expandTimer.current = window.setTimeout(() => setExpanded(true), 220)
      }}
      onMouseLeave={() => {
        window.clearTimeout(expandTimer.current)
        setExpanded(false)
      }}
    >
      <div className="toc-rail" aria-label="文档目录缩略栏">
        {rail.map((r) => {
          const h = headings.find((x) => x.id === r.id)
          if (!h) return null
          const active = r.id === activeId
          return (
            <button
              key={r.id}
              className={`toc-dash${active ? ' active' : ''}`}
              style={{ top: `${r.frac * 100}%` }}
              data-text={h.text}
              aria-label={h.text}
              onClick={() => jump(r.id)}
            >
              <span
                className="toc-dash-line"
                style={{ width: (DASH_WIDTH[h.level] ?? 9) + (active ? 4 : 0) }}
              />
            </button>
          )
        })}
      </div>
      {expanded && (
        <nav className="toc-float" aria-label="文档目录">
          {panel}
        </nav>
      )}
    </div>
  )
}
