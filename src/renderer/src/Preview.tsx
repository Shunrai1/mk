import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import mermaid from 'mermaid'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })

let mermaidSeq = 0

// 递归提取代码块原始文本（不受高亮 span 影响）
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

/** mermaid 代码块 → SVG；编辑时 300ms 防抖重渲染，语法错误保留上一次成功图形 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mmd-${++mermaidSeq}`
    const timer = setTimeout(() => {
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
  }, [code])

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

// 相对路径图片 → 基于文档所在目录的 file:// 地址（打包后可正常加载）
function resolveImageSrc(src: string | undefined, filePath: string | null): string | undefined {
  if (!src) return src
  if (/^(https?:|data:|file:)/i.test(src)) return src
  if (!filePath) return src
  const dir = filePath.replace(/[\\/][^\\/]*$/, '')
  const absolute = /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/') ? src : `${dir}/${src}`
  return 'file:///' + absolute.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 页内锚点（脚注引用 / 返回正文）在预览区内滚动定位，并短暂高亮目标 */
function jumpToAnchor(root: HTMLElement | null, id: string): void {
  const target = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  if (!target) return
  target.scrollIntoView({ block: 'center' })
  target.classList.add('anchor-flash')
  window.setTimeout(() => target.classList.remove('anchor-flash'), 1200)
}

export function Preview({ content, filePath }: { content: string; filePath: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
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
      img({ src, alt, ...props }) {
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
            return <MermaidBlock code={nodeText(codeChildren)} />
          }
        }
        return <pre>{children}</pre>
      }
    }),
    [filePath]
  )

  return (
    <div className="markdown-body" ref={rootRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, plainText: ['mermaid'] }]]}
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