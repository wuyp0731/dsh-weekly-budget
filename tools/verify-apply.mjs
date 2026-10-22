/**
 * 用 mock ctx 跑一遍 apply()，验证 summary.json 真的写到磁盘、内容自洽。
 *
 * 注意：Host 会把 summary 同时写到 $DSH_HOME 与默认的 ~/.dsh（客户端从那里读），
 * 所以本脚本先备份真实 summary，跑在临时 DSH_HOME 下，结束后恢复真实文件，
 * 不会冲掉正在运行的插件的快照。
 *
 * 用法：node tools/verify-apply.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, Config } from '../index.js'

const realSummary = path.join(os.homedir(), '.dsh', 'storages', 'weekly-budget', 'summary.json')
const backup = existsSync(realSummary) ? readFileSync(realSummary) : null

const tempHome = mkdtempSync(path.join(os.tmpdir(), 'weekly-budget-'))
process.env.DSH_HOME = tempHome
const summaryPath = path.join(tempHome, 'storages', 'weekly-budget', 'summary.json')

// 用 schemastery 的默认值构造配置；volatile 字段在真实 Loader 里是 { get() } 引用。
const resolved = typeof Config === 'function' ? Config({}) : (Config ?? {})
console.log('Config 解析结果：', Object.keys(resolved).join(','), '| weeklyLimit =', typeof resolved.weeklyLimit)

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

let failed = false
try {
  apply(ctx, config)
  await new Promise((resolve) => setTimeout(resolve, 1500))

  if (!existsSync(summaryPath)) {
    console.error('summary.json 没有生成：', summaryPath)
    failed = true
  } else {
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
    if (summary.version !== 1) {
      console.error('summary.version 不是 1：', summary.version)
      failed = true
    }
  }
} finally {
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  // 双写逻辑在测试期间覆盖过真实 summary：恢复备份（最坏情况回退一个刷新周期内的增量）。
  if (backup !== null) {
    mkdirSync(path.dirname(realSummary), { recursive: true })
    writeFileSync(realSummary, backup)
    console.log('已恢复真实 summary：', realSummary)
  } else if (existsSync(realSummary)) {
    rmSync(realSummary)
    console.log('已删除测试期间写入的真实 summary')
  }
  rmSync(tempHome, { recursive: true, force: true })
  delete process.env.DSH_HOME
}

if (failed) process.exit(1)
