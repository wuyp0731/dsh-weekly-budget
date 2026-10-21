/**
 * 用 mock ctx 跑一遍 apply()，验证 summary.json 真的写到磁盘、内容自洽。
 * 用法：node tools/verify-apply.mjs
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply, Config } from '../index.js'

const summaryPath = path.join(os.homedir(), '.dsh', 'storages', 'weekly-budget', 'summary.json')
if (existsSync(summaryPath)) rmSync(summaryPath)

// 用 schemastery 的默认值构造配置；volatile 字段在真实 Loader 里是 { get() } 引用。
const resolved = typeof Config === 'function' ? Config({}) : Config
console.log('Config 解析结果：', Object.keys(resolved), 'weeklyLimit =', resolved.weeklyLimit)

const volatile = (value) => ({ get: () => value })
const config = {
  ...resolved,
  enabled: volatile(true),
  weeklyLimit: volatile(80),
  weekStartsOn: volatile('monday'),
  inputPrice: volatile(2),
  cacheReadPrice: volatile(0.04),
  cacheWritePrice: volatile(0),
  outputPrice: volatile(8),
  peakPricingEnabled: volatile(true),
  offPeakRatio: volatile(0.5),
  refreshSeconds: 5,
}

const disposers = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  on() {},
}

apply(ctx, config)
await new Promise((resolve) => setTimeout(resolve, 1500))

if (!existsSync(summaryPath)) {
  console.error('summary.json 没有生成：', summaryPath)
  process.exit(1)
}
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
console.log('summary.json 已生成：', summaryPath)
console.log(JSON.stringify({
  version: summary.version,
  used: summary.used,
  limit: summary.limit,
  percent: summary.percent,
  status: summary.status,
  requests: summary.requests,
  sessions: summary.sessions,
  tokens: summary.tokens,
  models: summary.models.length,
  billing: summary.billing,
  scanned: summary.scanned,
  weekStart: new Date(summary.weekStart).toLocaleString(),
  weekEnd: new Date(summary.weekEnd).toLocaleString(),
}, null, 2))
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
