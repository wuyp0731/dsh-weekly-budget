/**
 * dsh-weekly-budget · Node half（Host 侧）
 *
 * 扫描本机 DeepSeek Harness 的持久会话日志，按本周窗口累计 assistant/message
 * 事件上报的 token 用量，用可配置单价折算成金额，写成 summary.json 供浏览器
 * 侧的「每周额度」胶囊读取。
 *
 * 为什么自己做日志解码而不是调 sessionQuery：
 * - 会话持久化是「若干标准 zstd 帧串联」的 JSONL（见 dsh-session-persistence-jsonl），
 *   Node 24 的 zlib.zstdDecompressSync 只解第一帧，必须自己按帧头切分逐帧解。
 * - 本插件对日志只读、不激活会话、不依赖内部服务，卸载后不留副作用。
 *
 * 口径说明：金额是「本机会话 token 用量 × 配置单价」的估算，不是 DeepSeek 官方账单。
 * 未缓存输入取 usage.inputTokens（与客户端 tokenUsage 投影的 uncachedInputTokens 同义）。
 */
import { promises as fsp, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

/** Cordis 插件名（也是 profile patch entry id 与 configForms 命名空间的来源）。 */
export const name = 'weekly-budget'

/** 不依赖其它 Host 服务：只读写本机文件。 */
export const inject = []

const STORAGE_SEGMENTS = ['storages', 'weekly-budget', 'summary.json']
const SUMMARY_VERSION = 1
// 官网 deepseek-flash 高峰价（元/百万 token，2026-10 抓取）：输入未命中 2、缓存命中 0.04、输出 8；DeepSeek 不单独收缓存写入费。
const DEFAULT_PRICES = { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }

/**
 * 解析 schemastery。安装方式可能是「复制进 profile/node_modules」或「link 到源码目录」，
 * 两者的模块解析根不同，因此这里按固定候选路径兜底加载，避免插件因找不到
 * @deepseek-ai/schemastery 而整体加载失败。
 * @returns schemastery 的默认导出（z）。
 */
function loadSchema() {
  const require = createRequire(import.meta.url)
  const candidates = [
    '@deepseek-ai/schemastery',
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery'),
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'schemastery'),
  ]
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate)
      // schemastery 的 CJS 导出就是 z 函数本身；兼容可能的 default 包装。
      if (typeof loaded === 'function' && typeof loaded.object === 'function') return loaded
      const wrapped = loaded !== null && typeof loaded === 'object' ? loaded.default : undefined
      if (typeof wrapped === 'function' && typeof wrapped.object === 'function') return wrapped
    } catch {
      // 继续尝试下一个候选；全都失败时抛最后一个错误。
    }
  }
  return require(candidates[candidates.length - 1])
}

let z = null
try {
  z = loadSchema()
} catch (error) {
  console.error('[weekly-budget] schemastery 不可用，插件无法声明配置：', error)
  z = null
}

const schema = z ?? { object: (shape) => shape, boolean: () => ({}), number: () => ({}), string: () => ({}), union: (items) => items, const: (value) => value }

/**
 * 插件配置：除 refreshSeconds 外都是 volatile，浏览器侧 configForms 可实时改写并回灌。
 *
 * 四个价格字段存的是「高峰价」（元/百万 token）；空闲时段按 offPeakRatio 折算
 * （官网规定空闲价 = 高峰价一半，见 https://api-docs.deepseek.com/zh-cn/quick_start/pricing）。
 */
export const Config = schema.object({
  enabled: schema.boolean().default(true).volatile(),
  weeklyLimit: schema.number().min(0).default(50).volatile(),
  weekStartsOn: schema.union([schema.const('monday'), schema.const('sunday')]).default('monday').volatile(),
  inputPrice: schema.number().min(0).default(2).volatile(),
  cacheReadPrice: schema.number().min(0).default(0.04).volatile(),
  cacheWritePrice: schema.number().min(0).default(0).volatile(),
  outputPrice: schema.number().min(0).default(8).volatile(),
  peakPricingEnabled: schema.boolean().default(true).volatile(),
  offPeakRatio: schema.number().min(0).max(1).default(0.5).volatile(),
  refreshSeconds: schema.number().min(5).max(600).default(20),
})

/**
 * 读取 volatile 配置字段的当前值。
 * @param field - config 上的字段（volatile 字段是 { get() } 引用）。
 * @param fallback - 字段缺失时的默认值。
 * @returns 当前值。
 */
function live(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field === undefined ? fallback : field
}

/**
 * 解析 DSH 主目录：$DSH_HOME（trim 后非空）优先，否则 ~/.dsh。
 * @returns 绝对路径。
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') {
    return path.resolve(configured.trim().replace(/^~(?=$|[\\/])/, os.homedir()))
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * 切分一段若干 zstd 帧串联的缓冲区。
 * 逐帧解析帧头（magic + FHD + window/dictionary/content-size + blocks + checksum），
 * 只返回完整帧；尾部被撕裂的帧以及任何不合法的字节序列一律丢弃。
 * @param buffer - 压缩文件内容。
 * @returns 完整帧的切片列表。
 */
function splitZstdFrames(buffer) {
  const frames = []
  const ZSTD_MAGIC = 0xfd2fb528
  let pos = 0
  while (pos + 5 <= buffer.length) {
    if (buffer.readUInt32LE(pos) !== ZSTD_MAGIC) break
    const start = pos
    const fhd = buffer[pos + 4]
    const fcsFlag = (fhd >>> 6) & 3
    const singleSegment = (fhd >>> 5) & 1
    const checksumFlag = (fhd >>> 2) & 1
    const dictFlag = fhd & 3
    let cursor = pos + 5
    if (singleSegment === 0) cursor += 1
    cursor += [0, 1, 2, 4][dictFlag]
    cursor += fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    let last = false
    while (!last) {
      if (cursor + 3 > buffer.length) return frames
      const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
      cursor += 3
      last = (header & 1) === 1
      const blockType = (header >>> 1) & 3
      const blockSize = header >>> 3
      cursor += blockType === 1 ? 1 : blockSize
      if (cursor > buffer.length) return frames
    }
    if (checksumFlag === 1) cursor += 4
    if (cursor > buffer.length) return frames
    frames.push(buffer.subarray(start, cursor))
    pos = cursor
  }
  return frames
}

/**
 * 解压一个 zstd 帧并返回其 UTF-8 文本。
 * @param frame - 单帧切片。
 * @returns 解压后的文本，失败时为 null。
 */
function decompressFrame(frame) {
  try {
    return zlib.zstdDecompressSync(frame).toString('utf8')
  } catch {
    return null
  }
}

/**
 * 把一个持久会话文件解码成逐条 assistant 用量记录。
 * @param buffer - 文件内容（压缩或原始 JSONL）。
 * @param compressed - 是否为 zstd 压缩格式。
 * @returns 用量记录列表。
 */
function decodeUsageRecords(buffer, compressed) {
  const records = []
  const texts = compressed ? splitZstdFrames(buffer).map(decompressFrame) : [buffer.toString('utf8')]
  for (const text of texts) {
    if (text === null || text === '') continue
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
      const data = event.data
      if (data === null || typeof data !== 'object') continue
      const usage = data.usage
      if (usage === null || typeof usage !== 'object') continue
      const time = typeof event.time === 'number' ? event.time : null
      if (time === null) continue
      const message = data.message
      const source = message !== null && typeof message === 'object' ? message.source : null
      const provider = source !== null && typeof source === 'object' && typeof source.provider === 'string' ? source.provider : 'unknown'
      const model = source !== null && typeof source === 'object' && typeof source.model === 'string' ? source.model : 'unknown'
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
      records.push({
        time,
        provider,
        model,
        input: number(usage.inputTokens),
        cacheRead: number(usage.cacheReadTokens),
        cacheWrite: number(usage.cacheWriteTokens),
        output: number(usage.outputTokens),
      })
    }
  }
  return records
}

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * 列举一个会话目录里规范版本最高的日志文件。
 * @param dir - 会话目录绝对路径。
 * @returns { file, version, compressed } 或 null。
 */
function pickCanonicalFile(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  for (const entry of names) {
    const match = SESSION_FILE.exec(entry)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    if (best !== null && version <= best.version) continue
    best = { file: path.join(dir, entry), version, compressed: match[2] !== undefined }
  }
  return best
}

/**
 * 列出持久化根下每个会话的规范日志文件。
 * @param sessionsRoot - <DSH_HOME>/sessions。
 * @returns [{ file, compressed }]。
 */
function listSessionFiles(sessionsRoot) {
  const found = []
  let projects
  try {
    projects = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, project.name)
    let sessions
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const picked = pickCanonicalFile(path.join(projectDir, session.name))
      if (picked !== null) found.push({ file: picked.file, compressed: picked.compressed })
    }
  }
  return found
}

/**
 * 计算本地时区下本周窗口。
 * @param now - 当前时刻（epoch ms）。
 * @param weekStartsOn - 'monday' | 'sunday'。
 * @returns { start, end }（epoch ms，end 为下周边界，不含）。
 */
function currentWeek(now, weekStartsOn) {
  const current = new Date(now)
  const target = weekStartsOn === 'sunday' ? 0 : 1
  const offset = (current.getDay() - target + 7) % 7
  const start = new Date(current.getFullYear(), current.getMonth(), current.getDate() - offset, 0, 0, 0, 0)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 0, 0, 0, 0)
  return { start: start.getTime(), end: end.getTime() }
}

/**
 * 判断一个时刻是否落在官网定义的「高峰时段」。
 * 官网口径：北京时间（UTC+8）周一至周五 9:00–12:00、14:00–18:00 为高峰，
 * 其余时段与周末为低谷（法定节假日官网也算低谷，这里无法判断，README 已注明）。
 * @param ms - epoch ms。
 * @returns 高峰时段返回 true。
 */
function isPeakTime(ms) {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

/** 仅供 tools/verify-stats.mjs 使用的内部导出：切帧、解码、周窗口与汇总。 */
export { splitZstdFrames, decodeUsageRecords, currentWeek, summarize, listSessionFiles, resolveDshHome }

/** 把空闲折扣率夹到 0–1；非法值回落到 0.5（官网的空闲价 = 高峰价一半）。 */
function clampRatio(value) {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}

/** 金额保留 6 位小数。 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * 汇总本周记录。
 * @param recordsBySession - Map<sessionId, records[]>。
 * @param options - 窗口与单价。
 * @returns summary 对象（未写盘）。
 */
function summarize(recordsBySession, options) {
  const { weekStart, weekEnd, prices, limit, weekStartsOn, offPeakRatio, peakPricingEnabled } = options
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const models = new Map()
  let requests = 0
  let used = 0
  let activeSessions = 0
  for (const records of recordsBySession.values()) {
    let touched = false
    for (const record of records) {
      if (record.time < weekStart || record.time >= weekEnd) continue
      touched = true
      requests += 1
      tokens.input += record.input
      tokens.cacheRead += record.cacheRead
      tokens.cacheWrite += record.cacheWrite
      tokens.output += record.output
      const discount = peakPricingEnabled && !isPeakTime(record.time) ? offPeakRatio : 1
      const cost = (record.input * prices.input + record.cacheRead * prices.cacheRead + record.cacheWrite * prices.cacheWrite + record.output * prices.output) * discount / 1e6
      used += cost
      const key = record.provider + '\u0000' + record.model
      let entry = models.get(key)
      if (entry === undefined) {
        entry = { provider: record.provider, model: record.model, requests: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0 }
        models.set(key, entry)
      }
      entry.requests += 1
      entry.tokens.input += record.input
      entry.tokens.cacheRead += record.cacheRead
      entry.tokens.cacheWrite += record.cacheWrite
      entry.tokens.output += record.output
      entry.cost += cost
    }
    if (touched) activeSessions += 1
  }
  const ratio = limit > 0 ? used / limit : null
  const status = ratio === null ? (used > 0 ? 'over' : 'ok') : ratio < 0.8 ? 'ok' : ratio < 1 ? 'warn' : 'over'
  const modelList = [...models.values()]
    .map((entry) => ({ ...entry, cost: round6(entry.cost) }))
    .sort((a, b) => b.cost - a.cost)
  return {
    version: SUMMARY_VERSION,
    generatedAt: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekStartsOn,
    weekStart,
    weekEnd,
    currency: 'CNY',
    limit,
    used: round6(used),
    remaining: round6(limit - used),
    ratio: ratio === null ? null : round6(ratio),
    percent: ratio === null ? null : Math.round(ratio * 1000) / 10,
    status,
    requests,
    tokens,
    models: modelList,
    sessions: activeSessions,
    prices,
    billing: {
      peakPricing: peakPricingEnabled,
      offPeakRatio,
      timeZone: 'Asia/Shanghai (UTC+8)',
      peakHours: 'Mon-Fri 09:00-12:00, 14:00-18:00',
      effective: {
        peak: prices,
        offPeak: {
          input: round6(prices.input * offPeakRatio),
          cacheRead: round6(prices.cacheRead * offPeakRatio),
          cacheWrite: round6(prices.cacheWrite * offPeakRatio),
          output: round6(prices.output * offPeakRatio),
        },
      },
    },
  }
}

/**
 * 插件主体。
 * @param ctx - Cordis 上下文。
 * @param config - 已校验的配置。
 */
export function apply(ctx, config) {
  const dshHome = resolveDshHome()
  const sessionsRoot = path.join(dshHome, 'sessions')
  const fallbackHome = path.join(os.homedir(), '.dsh')
  const summaryPaths = [path.join(dshHome, ...STORAGE_SEGMENTS)]
  if (path.resolve(dshHome) !== path.resolve(fallbackHome)) {
    summaryPaths.push(path.join(fallbackHome, ...STORAGE_SEGMENTS))
  }

  /** Map<file, { size, mtimeMs, records }>：文件不变就不重读。 */
  const cache = new Map()
  let running = false
  let rerun = false
  let disposed = false

  const readPrices = () => ({
    input: Number(live(config.inputPrice, DEFAULT_PRICES.input)) || 0,
    cacheRead: Number(live(config.cacheReadPrice, DEFAULT_PRICES.cacheRead)) || 0,
    cacheWrite: Number(live(config.cacheWritePrice, DEFAULT_PRICES.cacheWrite)) || 0,
    output: Number(live(config.outputPrice, DEFAULT_PRICES.output)) || 0,
  })

  const readLimit = () => {
    const value = Number(live(config.weeklyLimit, 50))
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * 重新扫描日志并写出 summary。
   * @param reason - 触发来源（仅用于日志）。
   */
  async function refresh(reason) {
    if (!live(config.enabled, true)) return
    if (running) {
      rerun = true
      return
    }
    running = true
    const started = Date.now()
    try {
      const files = listSessionFiles(sessionsRoot)
      let decoded = 0
      const bySession = new Map()
      for (const entry of files) {
        let stat
        try {
          stat = statSync(entry.file)
        } catch {
          continue
        }
        let record = cache.get(entry.file)
        if (record === undefined || record.size !== stat.size || record.mtimeMs !== stat.mtimeMs) {
          let buffer
          try {
            buffer = await fsp.readFile(entry.file)
          } catch {
            continue
          }
          record = { size: stat.size, mtimeMs: stat.mtimeMs, records: decodeUsageRecords(buffer, entry.compressed) }
          cache.set(entry.file, record)
          decoded += 1
          if (decoded % 8 === 0) await new Promise((resolve) => setImmediate(resolve))
        }
        bySession.set(entry.file, record.records)
      }

      const now = Date.now()
      const weekStartsOn = live(config.weekStartsOn, 'monday') === 'sunday' ? 'sunday' : 'monday'
      const { start, end } = currentWeek(now, weekStartsOn)
      const prices = readPrices()
      const offPeakRatio = clampRatio(Number(live(config.offPeakRatio, 0.5)))
      const peakPricingEnabled = live(config.peakPricingEnabled, true) !== false
      const summary = summarize(bySession, {
        weekStart: start,
        weekEnd: end,
        prices,
        limit: readLimit(),
        weekStartsOn,
        offPeakRatio,
        peakPricingEnabled,
      })
      summary.scanned = { sessions: bySession.size, files: files.length, durationMs: Date.now() - started }
      const text = JSON.stringify(summary, null, 2)
      for (const target of summaryPaths) {
        try {
          await fsp.mkdir(path.dirname(target), { recursive: true })
          const temp = target + '.' + process.pid + '.tmp'
          await fsp.writeFile(temp, text, 'utf8')
          await fsp.rename(temp, target)
        } catch (error) {
          console.error('[weekly-budget] 写 summary 失败：', target, error)
        }
      }
      if (process.env.DSH_WEEKLY_BUDGET_DEBUG) {
        console.log('[weekly-budget] refresh', reason, 'used=', summary.used, 'requests=', summary.requests, 'sessions=', summary.sessions, 'ms=', summary.scanned.durationMs)
      }
    } catch (error) {
      console.error('[weekly-budget] 统计失败：', error)
    } finally {
      running = false
      if (rerun && !disposed) {
        rerun = false
        void refresh('rerun')
      }
    }
  }

  // 启动后立即算一次，之后按刷新间隔重算。定时器随插件 fiber 释放。
  void refresh('start')
  const seconds = Number(live(config.refreshSeconds, 20))
  const intervalMs = Math.max(5, Math.min(600, Number.isFinite(seconds) ? seconds : 20)) * 1000
  ctx.effect(() => {
    const timer = setInterval(() => {
      void refresh('timer')
    }, intervalMs)
    return () => clearInterval(timer)
  }, 'weekly-budget: refresh timer')

  // 配置（volatile）变化立即重算：上限或单价改了，进度条要马上反映。
  try {
    ctx.on('loader/volatile-update', () => {
      void refresh('config')
    })
  } catch (error) {
    console.error('[weekly-budget] 无法监听配置变化：', error)
  }
}
