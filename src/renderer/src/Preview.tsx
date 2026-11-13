import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'
import type { Root, RootContent } from 'mdast'
import mermaid, { type MermaidConfig } from 'mermaid'
import 'katex/dist/katex.min.css'
import type { Theme } from '../../preload'

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })

// 各主题的 mermaid 配置：暗黑用内置 dark，网格用 base + 暖色变量贴合方格纸。
// mermaid.initialize 每次都会重置为默认配置再合并，主题间不会残留变量。
const MERMAID_CONFIG: Record<Theme, MermaidConfig> = {
  light: { theme: 'default' },
  dark: { theme: 'dark' },
  grid: {
    theme: 'base',
    themeVariables: {
      background: '#fdf8e2',
      mainBkg: '#fdf3cd',
      primaryColor: '#fdf3cd',
      primaryBorderColor: '#c9b45e',
      primaryTextColor: '#4a411f',
      secondaryColor: '#f6e9b8',
      tertiaryColor: '#fbf5dd',
      nodeBorder: '#c9b45e',
      lineColor: '#a3903f',
      textColor: '#4a411f',
      titleColor: '#4a411f',
      clusterBkg: '#faf2d0',
      clusterBorder: '#d4c276',
      edgeLabelBackground: '#fdf8e2'
    }
  }
}

// 原始 HTML（从网页/Word 复制的 <table> 等）由 rehype-raw 解析成真实节点，
// 再用 rehype-sanitize 过滤 <script>、事件属性、危险协议等内容。
// 在默认（GitHub 风格）schema 基础上放开两类被现有渲染依赖的 class：
// sanitize 只认同一属性名的第一条规则，所以 className 的候选值要写进同一条。
const SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  // 脚注 id 已由 remark 加上 user-content- 前缀，sanitize 不能再加一次，否则锚点失效
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    // remark-math 生成的公式节点是 <code class="language-math math-inline|math-display">
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    // 脚注区块标题自定义了 footnotes-title 类
    h2: [['className', 'sr-only', 'footnotes-title']],
    // 连续空行占位块
    div: [['className', 'md-blank']]
  }
}

// Markdown 会把连续空行折叠成一个段落间隔。这里按源码行号在顶层块之间
// 插入等高占位块（每多出的一个空行插一个），让手写的多行空白体现为留白。
function remarkBlankLines(): (tree: Root) => void {
  return (tree) => {
    const children = tree.children
    if (children.length < 2) return
    const next: RootContent[] = []
    for (let i = 0; i < children.length; i++) {
      const prevEnd = children[i - 1]?.position?.end.line
      const start = children[i].position?.start.line
      if (prevEnd != null && start != null) {
        for (let n = 0; n < start - prevEnd - 2; n++) {
          next.push({ type: 'html', value: '<div class="md-blank"></div>' })
        }
      }
      next.push(children[i])
    }
    tree.children = next
  }
}

let mermaidSeq = 0

// 递归提取代码块原始文本（不受高亮 span 影响）
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

/** mermaid 代码块 → SVG；编辑时 300ms 防抖重渲染，语法错误保留上一次成功图形；
    主题切换时按新主题重新渲染 */
function MermaidBlock({ code, theme }: { code: string; theme: Theme }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mmd-${++mermaidSeq}`
    const timer = setTimeout(() => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        ...MERMAID_CONFIG[theme]
      })
      mermaid
        .render(id, code)
        .then((result) => {
          if (!cancelled) {
            setSvg(result.svg)
            setError(null)
          }
        })
        .catch((err: unknown) => {
          // 渲染失败时 mermaid 可能残留临时节点，手动清理
          document.getElementById(id)?.remove()
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, theme])

  return (
    <div className="mermaid-block">
      {error && <div className="mermaid-error">Mermaid 语法错误：{error}</div>}
      {svg ? (
        <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        !error && <div className="mermaid-loading">图表渲染中…</div>
      )}
    </div>
  )
}

// 相对/绝对本地路径 → mkimg:// 自定义协议（主进程读盘返回字节）。
// 相比 file://：开发模式页面源是 http://localhost，file:// 图片会被 webSecurity 拦截。
function fileUrlToPath(src: string): string {
  try {
    const p = decodeURIComponent(new URL(src).pathname)
    // Windows 下 pathname 形如 /C:/dir/a.png，去掉盘符前的斜杠
    return p.replace(/^\/([a-zA-Z]:)/, '$1')
  } catch {
    return src.replace(/^file:\/\/+/i, '')
  }
}

function resolveImageSrc(src: string | undefined, filePath: string | null): string | undefined {
  if (!src) return src
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  let path = /^file:/i.test(src) ? fileUrlToPath(src) : src
  // Markdown 中可能写成 %20 之类，先还原成真实文件名再交给主进程
  try {
    path = decodeURI(path)
  } catch {
    // 非法转义保持原样
  }
  const isAbsolute =
    /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')
  if (!isAbsolute) {
    if (!filePath) return src
    const dir = filePath.replace(/[\\/][^\\/]*$/, '')
    path = `${dir}/${path}`
  }
  return `mkimg://img/?p=${encodeURIComponent(path.replace(/\\/g, '/'))}`
}

let flashTimer = 0

/** 短暂高亮锚点目标（不滚动），目录跳转与脚注共用 */
export function flashAnchor(root: HTMLElement | null, id: string): void {
  const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  if (!target) return
  root?.querySelectorAll('.anchor-flash').forEach((el) => el.classList.remove('anchor-flash'))
  window.clearTimeout(flashTimer)
  // 强制重排，连续点击同一个脚注也能重新播放高亮
  void target.offsetWidth
  target.classList.add('anchor-flash')
  flashTimer = window.setTimeout(() => target.classList.remove('anchor-flash'), 1200)
}

/** 页内锚点（脚注引用 / 返回正文）在预览区内滚动定位，并短暂高亮目标 */
export function jumpToAnchor(root: HTMLElement | null, id: string): void {
  const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  if (!target) return
  target.scrollIntoView({ block: 'center' })
  flashAnchor(root, id)
}

export function Preview({
  content,
  filePath,
  rootRef,
  theme,
  searchActive,
  searchQuery,
  searchCaseSensitive,
  searchIndex,
  onSearchCount
}: {
  content: string
  filePath: string | null
  rootRef: RefObject<HTMLDivElement>
  theme: Theme
  searchActive: boolean
  searchQuery: string
  searchCaseSensitive: boolean
  searchIndex: number
  onSearchCount: (count: number) => void
}) {
  const rangesRef = useRef<Range[]>([])
  const components = useMemo<Components>(
    () => ({
      // node 是 react-markdown 注入的 hast 节点，必须剔除，否则会被当成 DOM 属性渲染出去
      a({ node, href, children, ...props }) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              if (!href) return
              if (/^https?:/i.test(href)) window.api.openExternal(href)
              else if (href.startsWith('#')) jumpToAnchor(rootRef.current, href.slice(1))
            }}
          >
            {children}
          </a>
        )
      },
      img({ node, src, alt, ...props }) {
        return (
          <img
            {...props}
            src={resolveImageSrc(typeof src === 'string' ? src : undefined, filePath)}
            alt={alt ?? ''}
            loading="lazy"
          />
        )
      },
      pre({ children }) {
        const child = Array.isArray(children) ? children[0] : children
        if (isValidElement(child)) {
          const { className, children: codeChildren } = child.props as {
            className?: string
            children?: ReactNode
          }
          if (typeof className === 'string' && className.split(/\s+/).includes('language-mermaid')) {
            return <MermaidBlock code={nodeText(codeChildren)} theme={theme} />
          }
        }
        return <pre>{children}</pre>
      }
    }),
    [filePath, theme]
  )

  // 查找高亮：用 CSS Custom Highlight API 直接标记文本 Range，
  // 不包裹 DOM 节点，避免与 react-markdown 的重渲染冲突。
  useEffect(() => {
    const root = rootRef.current
    const ranges: Range[] = []
    if (root && searchActive && searchQuery) {
      const needle = searchCaseSensitive ? searchQuery : searchQuery.toLowerCase()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const el = node.parentElement
          // 跳过 mermaid SVG 与 KaTeX 公式内部文本，避免干扰其排版
          if (!el || el.closest('svg, .katex, script, style')) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        }
      })
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = searchCaseSensitive ? (node.nodeValue ?? '') : (node.nodeValue ?? '').toLowerCase()
        for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
          const range = new Range()
          range.setStart(node, i)
          range.setEnd(node, i + needle.length)
          ranges.push(range)
        }
      }
    }
    rangesRef.current = ranges
    CSS.highlights.set('preview-search', new Highlight(...ranges))
    onSearchCount(ranges.length)
  }, [content, searchActive, searchQuery, searchCaseSensitive, onSearchCount])

  // 当前匹配：单独一层更深的高亮，并在超出可视区域时滚动到视野中央
  useEffect(() => {
    const range = rangesRef.current[searchIndex]
    if (!searchActive || !range) {
      CSS.highlights.delete('preview-search-current')
      return
    }
    CSS.highlights.set('preview-search-current', new Highlight(range))
    // 滚动容器是外层 .preview-scroll（.markdown-body 本身不滚动）
    const scroller = rootRef.current?.parentElement
    if (!scroller) return
    const rect = range.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (rect.top < view.top + 56 || rect.bottom > view.bottom - 24) {
      scroller.scrollTop += rect.top - view.top - (view.height - rect.height) / 2
    }
  }, [content, searchActive, searchQuery, searchCaseSensitive, searchIndex])

  // 卸载（切到纯编辑模式）时清掉高亮注册
  useEffect(
    () => () => {
      CSS.highlights.delete('preview-search')
      CSS.highlights.delete('preview-search-current')
    },
    []
  )

  return (
    <div className="markdown-body" ref={rootRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks, remarkBlankLines]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, SANITIZE_SCHEMA],
          rehypeKatex,
          [rehypeHighlight, { detect: true, plainText: ['mermaid'] }]
        ]}
        remarkRehypeOptions={{
          footnoteLabel: '脚注',
          footnoteBackLabel: '返回正文',
          footnoteLabelProperties: { className: ['footnotes-title'] }
        }}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}