/**
 * 静态契约检查（不需要浏览器 / React）：
 *  1. client.js 的 inject 列表与 slot 注册 id；
 *  2. zh / en 字典键集一致；
 *  3. client.js 用到的每个 --dsw-* 变量都存在于主题包的变量表（若提供了提取文件）。
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

// 1. inject 列表
const injectMatch = /const inject = \[([^\]]*)\]/.exec(client)
if (injectMatch === null) fail('没找到 client.js 的 inject 列表')
else {
  const inject = injectMatch[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean)
  const required = ['slots', 'configForms', 'locale', 'remote', 'remote.workspaceFiles', 'sessions']
  const missing = required.filter((item) => !inject.includes(item))
  if (missing.length > 0) fail('inject 缺少：' + missing.join(', '))
  else pass('inject 完整：' + inject.join(', '))
}

// 2. slot 注册
if (!client.includes("'conversation.composer.dock'")) fail('没有注册 conversation.composer.dock')
else pass('注册 conversation.composer.dock')
const orderMatch = /id: 'weekly-budget',\s*order: 2/.exec(client)
if (orderMatch === null) fail('dock 条目 id/order 不是 weekly-budget/2')
else pass('dock 条目 id=weekly-budget order=2')

// 3. 字典键集
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

// 5. 主题变量（可选：把从 DSH app.asar 解出的 theme client.js 路径放进环境变量 DSH_THEME_CLIENT）
const themePath = process.env.DSH_THEME_CLIENT ?? ''
if (themePath !== '' && fs.existsSync(themePath)) {
  const theme = fs.readFileSync(themePath, 'utf8')
  const used = new Set([...client.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))
  const missing = [...used].filter((name) => !theme.includes(name))
  if (missing.length > 0) fail('主题变量不存在：' + missing.join(', '))
  else pass('主题变量全部存在（' + used.size + ' 个）')
} else {
  console.log('· 跳过主题变量检查（找不到 ' + themePath + '）')
}

if (failures > 0) {
  console.error('\n共 ' + failures + ' 项失败')
  process.exit(1)
}
console.log('\n全部静态契约检查通过')
