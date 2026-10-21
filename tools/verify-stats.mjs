/**
 * 验证 dsh-weekly-budget 的 Host 统计：用真实 ~/.dsh/sessions 跑一遍，
 * 打印本周窗口、金额、请求数、会话数与逐模型明细。
 *
 * 用法：node tools/verify-stats.mjs
 */
import path from 'node:path'
import os from 'node:os'
import {
  Config,
  splitZstdFrames,
  decodeUsageRecords,
  currentWeek,
  summarize,
  listSessionFiles,
  resolveDshHome,
} from '../index.js'
import { readFileSync, statSync } from 'node:fs'

console.log('Config 构造：', typeof Config, Object.keys(Config || {}))
console.log('DSH home =', resolveDshHome())
const sessionsRoot = path.join(resolveDshHome(), 'sessions')
const files = listSessionFiles(sessionsRoot)
console.log('会话日志文件数 =', files.length)

const bySession = new Map()
let totalRecords = 0
const started = Date.now()
for (const entry of files) {
  const buffer = readFileSync(entry.file)
  const frames = entry.compressed ? splitZstdFrames(buffer) : []
  const records = decodeUsageRecords(buffer, entry.compressed)
  totalRecords += records.length
  bySession.set(entry.file, records)
  if (process.env.VERBOSE) console.log(' ', path.basename(path.dirname(entry.file)), 'frames=', frames.length, 'records=', records.length)
}
console.log('总 assistant/message 记录 =', totalRecords, '解码耗时 =', Date.now() - started, 'ms')

const now = Date.now()
for (const startsOn of ['monday', 'sunday']) {
  const { start, end } = currentWeek(now, startsOn)
  const summary = summarize(bySession, {
    weekStart: start,
    weekEnd: end,
    prices: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    offPeakRatio: 0.5,
    peakPricingEnabled: true,
    limit: 50,
    weekStartsOn: startsOn,
  })
  console.log('\n== 周起始', startsOn, '==')
  console.log('窗口', new Date(start).toLocaleString(), '→', new Date(end).toLocaleString())
  console.log('已用 ¥' + summary.used, '/ 上限 ¥' + summary.limit, ' percent=', summary.percent, ' status=', summary.status)
  console.log('billing=', JSON.stringify(summary.billing))
  console.log('请求数', summary.requests, ' 本周会话数', summary.sessions, ' tokens=', summary.tokens)
  console.log('模型：')
  for (const model of summary.models) console.log('  ', model.provider + '/' + model.model, 'reqs=' + model.requests, 'cost=¥' + model.cost, JSON.stringify(model.tokens))
}

// 边界：截断的 zstd 缓冲区必须只是丢掉尾部，不抛异常
const sample = files.find((entry) => entry.compressed)
if (sample !== undefined) {
  const buffer = readFileSync(sample.file)
  const cut = buffer.subarray(0, Math.max(8, Math.floor(buffer.length / 2)))
  const frames = splitZstdFrames(cut)
  console.log('\n截断帧测试：半截缓冲区解出完整帧', frames.length, '个（原文件', splitZstdFrames(buffer).length, '个）')
}
