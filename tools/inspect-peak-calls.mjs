/**
 * 诊断：本周每次模型调用落在高峰还是空闲时段，以及用「请求时刻」与「完成时刻」
 * 判定峰谷时的差异（边界附近的长调用）。
 *
 * 用法：node tools/inspect-peak-calls.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { splitZstdFrames, listSessionFiles, resolveDshHome, currentWeek } from '../index.js'

const IS_PEAK = (ms) => {
  const shifted = new Date(ms + 8 * 3600000)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

const PRICES = { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }
const OFF_PEAK = 0.5
const cost = (usage, factor) => (usage.input * PRICES.input + usage.cacheRead * PRICES.cacheRead + usage.cacheWrite * PRICES.cacheWrite + usage.output * PRICES.output) * factor / 1e6

const { start, end } = currentWeek(Date.now(), 'monday')
const files = listSessionFiles(path.join(resolveDshHome(), 'sessions'))
const calls = []
for (const entry of files) {
  const buffer = fs.readFileSync(entry.file)
  const texts = entry.compressed ? splitZstdFrames(buffer).map((frame) => { try { return zlib.zstdDecompressSync(frame).toString('utf8') } catch { return null } }) : [buffer.toString('utf8')]
  let lastHeader = null
  let lastStepStart = null
  for (const text of texts) {
    if (text === null) continue
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'request/header') { lastHeader = event.time; lastStepStart = event.time }
      if (event.type === 'assistant/message' && event.data && event.data.usage) {
        const usage = event.data.usage
        const record = {
          time: event.time,
          requestTime: lastHeader,
          stepTime: lastStepStart,
          input: usage.inputTokens || 0,
          cacheRead: usage.cacheReadTokens || 0,
          cacheWrite: usage.cacheWriteTokens || 0,
          output: usage.outputTokens || 0,
        }
        calls.push(record)
      }
    }
  }
}
const inWeek = calls.filter((call) => call.time >= start && call.time < end)
const byEnd = inWeek.filter((call) => IS_PEAK(call.time))
const byEndOff = inWeek.length - byEnd.length
const mixed = inWeek.filter((call) => call.requestTime !== null && IS_PEAK(call.requestTime) !== IS_PEAK(call.time))

const sum = (list, factor) => ({
  calls: list.length,
  input: list.reduce((n, c) => n + c.input, 0),
  cacheRead: list.reduce((n, c) => n + c.cacheRead, 0),
  output: list.reduce((n, c) => n + c.output, 0),
  cost: list.reduce((n, c) => n + cost(c, factor), 0),
})
const peak = sum(byEnd, 1)
const off = sum(inWeek.filter((call) => !IS_PEAK(call.time)), OFF_PEAK)
const total = peak.cost + off.cost
const totalByRequest = inWeek.reduce((n, c) => n + cost(c, IS_PEAK(c.requestTime === null ? c.time : c.requestTime) ? 1 : OFF_PEAK), 0)

console.log('本周调用总数 =', inWeek.length)
console.log('按「完成时刻」判定：峰时', peak.calls, '次 / 空闲', off.calls, '次')
console.log('峰时 tokens：input', peak.input, 'cacheRead', peak.cacheRead, 'output', peak.output, '→ ¥' + peak.cost.toFixed(4))
console.log('谷时 tokens：input', off.input, 'cacheRead', off.cacheRead, 'output', off.output, '→ ¥' + off.cost.toFixed(4))
console.log('合计 ¥' + total.toFixed(4))
console.log('')
console.log('用「请求时刻」判定时，归属不同的调用 =', mixed.length, '次（总时长/差示例见下）')
console.log('两种判定合计差异 = ¥' + Math.abs(total - totalByRequest).toFixed(6))
const nearBoundary = inWeek.filter((call) => {
  const minute = new Date(call.time + 8 * 3600000).getUTCHours() * 60 + new Date(call.time + 8 * 3600000).getUTCMinutes()
  return [540, 720, 840, 1080].some((edge) => Math.abs(minute - edge) <= 2)
})
console.log('完成时刻落在边界 ±2 分钟内的调用 =', nearBoundary.length, '次')
for (const call of mixed.slice(0, 5)) {
  console.log('  完成', new Date(call.time + 8 * 3600000).toISOString().slice(0, 16), '请求', call.requestTime === null ? '—' : new Date(call.requestTime + 8 * 3600000).toISOString().slice(0, 16), 'input', call.input, 'output', call.output)
}
