// 生成高清应用图标：SVG（渐变圆角底 + 白色 Markdown 标志）→ 多尺寸 PNG → build/icon.ico
// 用法：node scripts/generate-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')
mkdirSync(outDir, { recursive: true })

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5B7CFA"/>
      <stop offset="1" stop-color="#7C3AED"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg)"/>
  <path transform="translate(4.6 60.8) scale(1.05)" fill="#FFFFFF"
    d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"/>
</svg>`

// density 288 → 以 1024x1024 栅格化，保证缩小后各尺寸清晰
const master = await sharp(Buffer.from(svg), { density: 288 }).png().toBuffer()

const sizes = [256, 128, 64, 48, 32, 24, 16]
const pngs = await Promise.all(
  sizes.map((s) => sharp(master).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer())
)

// 手工拼 ICO（PNG 压缩条目，Vista+ 支持）
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // 保留位
header.writeUInt16LE(1, 2) // 类型：图标
header.writeUInt16LE(sizes.length, 4)

let offset = 6 + 16 * sizes.length
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0) // 宽（0 表示 256）
  e.writeUInt8(s >= 256 ? 0 : s, 1) // 高
  e.writeUInt8(0, 2) // 调色板
  e.writeUInt8(0, 3) // 保留
  e.writeUInt16LE(1, 4) // 色彩平面
  e.writeUInt16LE(32, 6) // 位深
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  return e
})

writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]))
await sharp(master).resize(512, 512).png().toFile(join(outDir, 'icon.png'))
console.log('已生成 build/icon.ico（16~256px）与 build/icon.png（512px）')