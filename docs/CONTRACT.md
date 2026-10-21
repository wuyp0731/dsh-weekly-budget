# dsh-weekly-budget · 实现契约（唯一真源）

本文件由 Lead 维护。host / client 两半必须严格按此契约交换数据；改契约先改这里。

## 1. 目标

在 DeepSeek Harness Web GUI 的输入框（composer）下方加一个「每周额度」按钮：
按钮上带进度条，显示本周已使用金额；点击打开弹窗，可配置每周消费金额上限，
并查看本周 token 明细与按模型折算的金额。

金额口径：**本机所有会话在本周窗口内，按 assistant/message 事件上报的 token 用量
与可配置单价折算出的估算值**，不是 DeepSeek 官方账单。UI 与 README 必须如实说明。

## 2. 文件布局与写范围

```
dsh-weekly-budget/
  package.json        # 已就绪（Lead 维护）
  cordis.patch.yml    # 已就绪（Lead 维护）；entry id = weekly-budget = configForms 命名空间
  index.js            # Host 半端（host-dev）
  client.js           # Client 半端（client-dev）
  locale/zh.json      # 已就绪（插件管理器元信息）
  locale/en.json      # 已就绪
  icon.svg            # 已就绪
  README.md           # docs-installer
  docs/CONTRACT.md    # 本文件（Lead 维护）
```

不要修改职责范围外的文件。

## 3. Host 半端（index.js）

- 默认导出 `name = 'weekly-budget'`、`Config`（schemastery）、`apply(ctx, config)`。
- 依赖：`inject = []`（不依赖其它服务；用 node:fs / node:path / node:os / node:zlib 自行扫描）。
- Config 字段（全部扁平，除 refreshSeconds 外都是 `.volatile()`）。单价字段存的是**高峰价**；
  空闲时段按 `offPeakRatio` 折算（官网：空闲价 = 高峰价一半）：

| 字段 | 类型 | 默认 | volatile | 含义 |
|---|---|---|---|---|
| enabled | boolean | true | 是 | 是否启用统计与按钮 |
| weeklyLimit | number | 50 | 是 | 每周消费上限（元） |
| weekStartsOn | 'monday' | 'sunday' | 'monday' | 是 | 每周起始日 |
| inputPrice | number | 2 | 是 | 未缓存输入峰价，元/百万 token |
| cacheReadPrice | number | 0.04 | 是 | 缓存命中输入峰价，元/百万 token |
| cacheWritePrice | number | 0 | 是 | 缓存写入峰价（DeepSeek 不收该项） |
| outputPrice | number | 8 | 是 | 输出峰价，元/百万 token |
| peakPricingEnabled | boolean | true | 是 | 是否启用峰谷计价 |
| offPeakRatio | number | 0.5 | 是 | 空闲时段折扣率（0–1） |
| refreshSeconds | number | 20 | 否 | 后台重算间隔（秒，5–600） |

- 数据来源：扫描 `<DSH_HOME>/sessions/**/session-*.jsonl.zstd` 与未压缩的 `session*.jsonl`
  （每个会话目录取版本号最高的规范文件；v4 优先于 v0）。DSH_HOME 解析顺序：
  `$DSH_HOME`（trim 后非空）→ `os.homedir()/.dsh`。
- 日志是若干标准 zstd 帧串联。必须逐帧解压（Node 24 `node:zlib` 的
  `zstdDecompressSync` 一次只解第一帧）。按 zstd 帧头（magic + FHD + window/dict/FCS +
  blocks + checksum）精确切帧；尾部撕裂帧忽略。
- 每行 JSON 事件；只统计 `type === 'assistant/message'` 且有 `data.usage` 的事件：
  - 时间取事件 `time`（epoch ms）。
  - `data.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }`，
    其中 `inputTokens` 是**未缓存输入**（与客户端 tokenUsage 投影的 uncachedInputTokens 同义）。
  - 路由：`data.message.source.provider` 与 `data.message.source.model`。
- 周窗口：按本地时区，从 `weekStartsOn` 当天 00:00 起算 7 天。
- 金额：`base = (inputTokens*inputPrice + cacheReadTokens*cacheReadPrice +
  cacheWriteTokens*cacheWritePrice + outputTokens*outputPrice) / 1e6`；
  `cost = base × 时段系数`，时段系数 = 1（高峰）/ `offPeakRatio`（空闲）。
  峰谷按**北京时间 UTC+8** 判断：周一至周五 09:00–12:00、14:00–18:00 为高峰，其余与周末为空闲；
  法定节假日无法识别，README 已注明。`peakPricingEnabled=false` 时系数恒为 1。
- 缓存：按文件 `(size, mtimeMs)` 缓存已解析的逐事件用量，文件不变不重读。
- 写 summary：每 `refreshSeconds` 秒（且启动后立即）把最新汇总写到
  `<DSH_HOME>/storages/weekly-budget/summary.json`；若 `<DSH_HOME>` 不是
  `os.homedir()/.dsh`，**同时**写 `os.homedir()/.dsh/storages/weekly-budget/summary.json`。
  使用临时文件 + rename 原子替换。Config 变化（`loader/volatile-update`）立即重算。
- 失败要吞掉并 console.error，绝不能让插件挂掉。

### summary.json（version 1）

```json
{
  "version": 1,
  "generatedAt": 1792554978554,
  "timeZone": "Asia/Shanghai",
  "weekStartsOn": "monday",
  "weekStart": 1792,
  "weekEnd": 1792,
  "currency": "CNY",
  "limit": 50,
  "used": 12.3456,
  "remaining": 37.6544,
  "ratio": 0.2469,
  "percent": 24.7,
  "status": "ok",
  "requests": 42,
  "tokens": { "input": 1234567, "cacheRead": 7654321, "cacheWrite": 0, "output": 45678 },
  "models": [
    { "provider": "deepseek-account", "model": "deepseek-flash", "requests": 40,
      "tokens": { "input": 1, "cacheRead": 2, "cacheWrite": 3, "output": 4 }, "cost": 12.3456 }
  ],
  "sessions": 6,
  "prices": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
  "billing": {
    "peakPricing": true,
    "offPeakRatio": 0.5,
    "timeZone": "Asia/Shanghai (UTC+8)",
    "peakHours": "Mon-Fri 09:00-12:00, 14:00-18:00",
    "effective": {
      "peak": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
      "offPeak": { "input": 1, "cacheRead": 0.02, "cacheWrite": 0, "output": 4 }
    }
  },
  "scanned": { "sessions": 22, "files": 22, "durationMs": 130 }
}
```

- `ratio`：`used / limit`（limit <= 0 时为 null）；`percent`：ratio*100 四舍五入 1 位（null 时 null）。
- `status`：ratio < 0.8 → 'ok'；< 1 → 'warn'；>= 1（或 limit<=0 且有花费）→ 'over'。
- `models` 按 cost 降序。
- 数字保留 6 位小数；日期字段为 epoch ms（数字）。
- timeZone 用 `Intl.DateTimeFormat().resolvedOptions().timeZone`。

## 4. Client 半端（client.js）

- 通过 `window.__ModuleLoader__.load({ id: 'dsh-weekly-budget', factory(require) { ... } })` 注册。
- `inject = ['slots', 'configForms', 'locale', 'remote', 'remote.workspaceFiles', 'sessions']`。
- `apply(ctx)`：
  - `ctx.locale.register('weekly-budget', { zh, en })`（字典键集见 §5.4）。
  - `const form = ctx.configForms.get('weekly-budget')` 读写配置。
  - `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'weekly-budget', order: 2, locale: 'weekly-budget' }, WeeklyBudgetPill))`。
- 配置读写：
  - 读：`form.getSnapshot()?.value`（可能 undefined），`form.subscribe(fn)`。
  - 写：`form.set('weeklyLimit', 100)` 返回 Promise<boolean>；false/拒绝时回滚并提示。
- 数据读取：`const result = await ctx.remote.workspaceFiles.read(sessionId, path, {}, signal)`；
  成功 `result.ok === true` 且 `result.value.text` 是 JSON 文本；失败时 `result.ok === false`。
  候选路径依次尝试：
  1. `<hostHome>/.dsh/storages/weekly-budget/summary.json`
  2. `<hostHome>/storages/weekly-budget/summary.json`
  `hostHome = ctx.remote.$host?.home`（os.homedir()；可能 undefined）。
- sessionId：`props.sessionId` 优先；缺失时取 `ctx.sessions.list` 快照中 `retainedBy.mainView > 0` 的会话，
  再退回任意 retained 会话、再退回第一行。没有会话时不发请求、按钮仍可用（显示上限与 0）。
- 刷新：挂载即读；每 15 秒轮询；`window.addEventListener('focus')` 时读；点击弹窗「刷新」时读。
  组件卸载清理定时器与 abort。
- 不要引入任何第三方库；只用 React（`require('react')`、`require('react-dom')`）。

### 4.1 胶囊（dock 按钮）

`conversation.composer.dock` 是居中 flex 行，条目直接作为子元素。胶囊规格：

- 两行：第一行 `每周额度` + 金额 `¥12.34 / ¥50.00`（tabular-nums）；第二行 3px 进度条。
- 高度约 30px，圆角 `var(--dsw-radius-sm)`，字号 12px，颜色 `var(--dsw-alias-label-tertiary)`，
  hover/展开时背景 `var(--dsw-alias-interactive-bg-hover)`、文字 `var(--dsw-alias-label-secondary)`。
- 进度条：轨道 `var(--dsw-alias-border-l2)`，填充按 status：
  ok=`var(--dsw-alias-brand-primary)`、warn=`var(--dsw-alias-state-warning-primary)`、
  over=`var(--dsw-alias-state-error-primary)`（变量名若不可用退回 `#e6a23c` / `#e5484d`）。
- 宽度：`min(220px, 100%)`，文字溢出省略。百分比填充 clamp 到 0–100%。
- `aria-haspopup="dialog"`、`aria-expanded`、`aria-label` 含中文完整信息。
- 无 summary 时金额显示 `¥0.00 / ¥上限`，进度 0，并保留 `data-state="loading"`。

### 4.2 弹窗

点击胶囊打开，`react-dom` 的 `createPortal` 挂到 `document.body`：

- 面板：`position: fixed`，`z-index: 1100`，宽 `min(360px, calc(100vw - 24px))`，
  `border-radius: var(--dsw-radius-lg)`，背景 `var(--dsw-specific-menu)`，
  `box-shadow: var(--dsw-elevation-prominent)`，padding 16px，字号 12px/18px。
  定位在按钮上方（`rect.top - panelHeight - 8`，放不下时放下方），水平与按钮居中并 clamp 在视口内。
- 内容顺序：
  1. 标题行：左「每周额度」+ 鲸鱼小图标，右 `¥已用 / ¥上限`。
  2. 周范围副标题（本地化，如 `10月19日 – 10月25日`）。
  3. 8px 大进度条 + 右侧百分比（`24.7%`）。
  4. 明细 dl 两列：剩余额度、请求次数、输入 tokens、缓存命中 tokens、输出 tokens、本周会话。
     token 用紧凑单位（1.2K / 3.4M）。
  5. 「本周上限」行：number 输入（step 1/min 0）+`保存`按钮；保存成功短暂提示「已保存」。
  6. 「每周起始」行：`<select>` 周一/周日，变更立即保存。
  7. 「峰价（元/百万 token）」折叠区（默认收起）：输入、缓存命中、缓存写入、输出 四个 number 输入 + 保存；
     下方「同步官网定价」按钮按本周用量最大的模型套用内置官网快照（OFFICIAL_PRICING，
     2026-10-17 抓取），并写 `peakPricingEnabled=true`、`offPeakRatio=0.5`；
     再下面是峰谷说明与价格来源小字。
  8. 模型明细（models.length > 0 时）：每行 `model` + 金额，最多 8 行，超出折叠为「等 N 个模型」。
  9. 底部：左「更新于 HH:mm:ss」，右「刷新」按钮。
- 交互：Escape 关闭；面板外 pointerdown/click 关闭；点击面板内部不关闭；打开时按钮保持 `aria-expanded`。
- 文案必须说明金额为估算：底部或明细下方小字「按本机会话用量折算，非官方账单」。
- 若读到错误（文件不存在除外）在弹窗内显示一行温和提示，不阻塞配置。
- disabled（`enabled === false`）时整个胶囊返回 null。

### 4.3 样式

- 所有类名加 `wb-` 前缀，用 `<style>` 注入一次（按 `data-plugin-css` 去重可选）。
- 仅使用 `--dsw-*` 主题变量，不要写死深浅色。
- 尊重 `prefers-reduced-motion`（进度条过渡可关）。

## 5. 验收标准

1. `node --check index.js` 与 `node --check client.js` 通过。
2. 本地脚本用真实 `~/.dsh/sessions` 跑 host 统计，本周金额与逐帧解压结果自洽。
3. 插件安装进 profile 后，GUI 输入框下方出现「每周额度」胶囊，进度条比例正确。
4. 点击胶囊出现弹窗，能修改上限并持久化（刷新页面后仍生效）。
5. 中英文文案完整（zh 键集 == en 键集）。
6. README 说明安装、配置、口径与限制。

## 6. 参考（只读，别改）

> 下列 `*_lib_client.js` / `*_README.zh.md` 是从 DSH 安装包的 `app.asar` 中解出的文件，
> 文件名里的下划线用于代替原路径分隔符。

- `<profile>/node_modules/dsh-whale-persona/lib/client.js`（configForms 用法；`<profile>` 指 `~/.dsh/profiles/<名字>`）
- `dsh-client-ui-chat/lib/client.js`（从 DSH 安装包的 `app.asar` 解出）
  （第 7373 行胶囊 CSS、第 6814 行弹窗 CSS、第 7516 行 DialogPill 交互）
- `dsh-client-ui-conversation_lib_client.js`（从 `app.asar` 解出）
  （第 18703 行 dock 容器 CSS）
- `dsh-api-workspace-files_README.zh.md`（`app.asar` 内的 read 签名文档）
