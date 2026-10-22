/**
 * 静态契约检查（不需要浏览器 / React）：
 *  1. client.js 的 inject 列表与 slot 注册参数（含 locale 命名空间）；
 *  2. zh / en 字典键集一致；
 *  3. 显示资源：package.json 导出 ./icon、图标文件真实可用、locale meta 齐全、LICENSE 存在；
 *  4. Host 与 Client 的配合点（name / summary 路径 / bundle patch / client.inject）；
 *  5. 可选：client.js 用到的 --dsw-* 变量是否存在于主题包（设置 DSH_THEME_CLIENT 才检查）。
 *
 * 用法：node tools/verify-static.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const host = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let failures = 0
const fail = (message) => {
  failures += 1
  console.error('❌ ' + message)
}
const pass = (message) => console.log('✅ ' + message)

// 1. inject 列表与 slot 注册
const injectMatch = /const inject = \[([^\]]*)\]/.exec(client)
if (injectMatch === null) fail('没找到 client.js 的 inject 列表')
else {
  const inject = injectMatch[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean)
  const required = ['slots', 'configForms', 'locale', 'remote', 'remote.workspaceFiles']
  const missing = required.filter((item) => !inject.includes(item))
  if (missing.length > 0) fail('inject 缺少：' + missing.join(', '))
  else pass('inject 完整：' + inject.join(', '))
  // ctx.sessions 没有 list 快照；声明它只会让插件多等一个服务。必须不再出现。
  if (inject.includes('sessions')) fail('inject 仍声明 sessions：Client sessions 服务没有 list 快照，这是无效依赖')
  if (client.includes('ctx.sessions')) fail('client.js 仍访问 ctx.sessions（该服务不提供会话列表快照）')
  else pass('未依赖 ctx.sessions 的会话列表快照')
}

if (!client.includes("'conversation.composer.dock'")) fail('没有注册 conversation.composer.dock')
else pass('注册 conversation.composer.dock')
const orderMatch = /id: 'weekly-budget',\s*order: 2/.exec(client)
if (orderMatch === null) fail('dock 条目 id/order 不是 weekly-budget/2')
else pass('dock 条目 id=weekly-budget order=2')
if (!/locale: LOCALE_NS/.test(client)) fail('dock 注册缺少 locale 命名空间（渲染器据此注入 t）')
else pass('dock 注册声明 locale 命名空间')

// 2. 字典键集
function dictionaryKeys(name) {
  const start = client.indexOf('const ' + name + ' = {')
  if (start < 0) return null
  const end = client.indexOf('\n    };', start)
  const block = client.slice(start, end)
  const keys = []
  for (const match of block.matchAll(/^\s*'([^']+)':/gm)) keys.push(match[1])
  return keys
}
const zhKeys = dictionaryKeys('zh')
const enKeys = dictionaryKeys('en')
if (zhKeys === null || enKeys === null) fail('没解析到 zh / en 字典')
else {
  const onlyZh = zhKeys.filter((key) => !enKeys.includes(key))
  const onlyEn = enKeys.filter((key) => !zhKeys.includes(key))
  if (onlyZh.length > 0 || onlyEn.length > 0) fail('字典键集不一致：仅 zh ' + JSON.stringify(onlyZh) + '，仅 en ' + JSON.stringify(onlyEn))
  else pass('字典键集一致，共 ' + zhKeys.length + ' 个键')
}

// 3. 显示资源：插件管理器的标题、描述与图标
const exportsMap = pkg.exports ?? {}
if (exportsMap['./icon'] !== './icon.svg') fail('package.json 没有导出 ./icon（插件管理器会退回默认图标）')
else pass('package.json 导出 ./icon')
if (exportsMap['./locale/*.json'] === undefined) fail('package.json 没有导出 ./locale/*.json')
else pass('package.json 导出 locale 资源')
if (!Array.isArray(pkg.files) || !pkg.files.includes('icon.svg')) fail('package.json files 未包含 icon.svg')
else pass('package.json files 包含 icon.svg / locale / LICENSE')

const iconPath = path.join(root, 'icon.svg')
if (!fs.existsSync(iconPath)) fail('icon.svg 不存在')
else {
  const bytes = fs.statSync(iconPath).size
  if (bytes > 256 * 1024) fail('icon.svg 超过 256 KiB 上限：' + bytes + ' 字节')
  else if (!fs.readFileSync(iconPath, 'utf8').trimStart().startsWith('<svg')) fail('icon.svg 不是有效的 SVG 文本')
  else pass('icon.svg 有效（' + bytes + ' 字节）')
}

for (const locale of ['zh', 'en']) {
  const file = path.join(root, 'locale', locale + '.json')
  if (!fs.existsSync(file)) {
    fail('locale/' + locale + '.json 不存在')
    continue
  }
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8')).meta
  } catch (error) {
    fail('locale/' + locale + '.json 不是合法 JSON：' + error.message)
    continue
  }
  if (meta === undefined || typeof meta.title !== 'string' || meta.title.trim() === '') fail('locale/' + locale + '.json 缺 meta.title')
  else if (typeof meta.description !== 'string' || meta.description.trim() === '') fail('locale/' + locale + '.json 缺 meta.description')
  else pass('locale/' + locale + '.json 的 meta 齐全（' + meta.title + '）')
}

if (typeof pkg.license !== 'string' || pkg.license.trim() === '') fail('package.json 缺 license 字段')
else if (!fs.existsSync(path.join(root, 'LICENSE'))) fail('有 license 字段但没有 LICENSE 文件')
else pass('license 已声明：' + pkg.license)

// 4. Host 与 Client 的配合点
if (!host.includes("export const name = 'weekly-budget'")) fail('host name 不是 weekly-budget')
else pass('host name = weekly-budget')
if (!host.includes('storages') || !host.includes('weekly-budget') || !host.includes('summary.json')) fail('host 未按契约写 summary 路径')
else pass('host summary 路径符合契约')
if (!client.includes("storages/weekly-budget/summary.json")) fail('client 未按契约读 summary 路径')
else pass('client summary 路径符合契约')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json 缺 bundle patch')
else pass('package.json bundle patch 已声明')
if (!Array.isArray(pkg.dsh?.client?.inject)) fail('package.json 缺 client.inject')
else pass('package.json client.inject 已声明')

// 5. 主题变量（可选：把从 DSH app.asar 解出的主题 client.js 路径放进环境变量 DSH_THEME_CLIENT）
const themePath = process.env.DSH_THEME_CLIENT ?? ''
if (themePath !== '' && fs.existsSync(themePath)) {
  const theme = fs.readFileSync(themePath, 'utf8')
  const used = new Set([...client.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))
  const missing = [...used].filter((name) => !theme.includes(name))
  if (missing.length > 0) fail('主题变量不存在：' + missing.join(', '))
  else pass('主题变量全部存在（' + used.size + ' 个）')
} else {
  console.log('· 跳过主题变量检查（未设置 DSH_THEME_CLIENT，可选）')
}

if (failures > 0) {
  console.error('\n共 ' + failures + ' 项失败')
  process.exit(1)
}
console.log('\n全部静态契约检查通过')
