# dsh-weekly-budget（每周额度）

DeepSeek Harness Web UI 的每周消费额度插件。在输入框（composer）下方加一枚「每周额度」胶囊，
显示本周已花费金额、上限和进度条；点开弹窗可以改上限、每周起始日与单价，并查看本周
token 用量和按模型折算的金额。

> **金额是估算，不是 DeepSeek 官方账单。**
> 插件读取**本机** Harness 会话日志里上报的 token 用量，按你配置的单价折算成人民币。
> 与官方账单在口径、缓存命中判定、赠送额度、汇率等方面都可能不一致，只适合作预算参考。

## 快速安装（三步）

以插件源码位于 `<你的插件目录>`（例如 `D:\plugins\dsh-weekly-budget`）、profile 为 `desktop` 为例：

```powershell
# 1) 把本地目录链接进 profile（写入 dependencies）
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<你的插件目录>"
```

2. 打开 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，在 `dsh.profile.bundles`
   数组末尾追加 `"dsh-weekly-budget"`（CLI 只改 dependencies，不会自动加这一项）。
3. **完全重启 DeepSeek Harness**，再刷新页面。输入框下方出现「每周额度」胶囊即安装成功。

> Host 半端（`index.js`）只在应用启动时加载，所以第 3 步必须重启；只刷新页面不会生效。
> 详细步骤（手工安装、GitHub 安装、校验、卸载）见下方[安装](#安装)章节。

## 功能

- **输入框下方的额度胶囊**：两行显示「每周额度」与 `¥已用 / ¥上限`，下面一条 3px 进度条，
  按用量比例填充；`ok` 为品牌色、`warn`（≥80%）为警告色、`over`（≥100%）为错误色。
- **明细弹窗**：周范围、已用百分比、剩余额度、请求次数、输入/缓存命中/输出 token、
  本周会话数，以及按金额降序的模型明细（最多 8 行）。
- **就地配置**：弹窗内可修改每周上限、每周起始日（周一/周日）和四项**峰价**（未缓存输入、
  缓存命中、缓存写入、输出，单位：元/百万 token），保存后立即生效并持久化；点**「同步官网定价」**
  可一键套用官网价格快照（空闲时段自动半价）。
- **后台汇总**：Host 侧定期扫描本机会话日志，把本周统计写到
  `<DSH_HOME>/storages/weekly-budget/summary.json`；文件不变时命中缓存，不重复解析。
- **只读、不联网**：插件不修改会话日志、不调用任何远端接口，也不影响对话本身。

## 金额口径

对本周窗口内每个 `assistant/message` 事件携带的 `usage` 逐条折算后求和：

```text
base = (inputTokens      × inputPrice
      + cacheReadTokens  × cacheReadPrice
      + cacheWriteTokens × cacheWritePrice
      + outputTokens     × outputPrice) / 1,000,000

cost = base × 时段系数        # 高峰时刻 = 1，空闲时刻 = offPeakRatio（默认 0.5）
```

- `inputTokens` 是**未缓存输入**（等同于客户端 token 用量里的 uncached input），
  不是「输入总量」；缓存命中的部分走 `cacheReadPrice` 计费。
- 单价单位是**元 / 百万 token**。默认值取自官网 deepseek-flash 的**高峰价**：
  未缓存输入 2、缓存命中 0.04、缓存写入 0（DeepSeek 不单独收缓存写入费）、输出 8。
- **峰谷自动计价**：官网规定空闲时段价格是高峰价的一半。插件按每个请求的**北京时间**
  判断时段——周一至周五 9:00–12:00、14:00–18:00 为高峰，其余时段与周末按 `offPeakRatio`
  （默认 0.5）折算。中国法定节假日官网也按空闲价，插件无法识别，会按工作日高峰价计算（略偏高）。
- 弹窗里点**「同步官网定价」**会按本周用量最大的模型，把内置的官网价格快照（2026-10-17）
  填成峰价并打开峰谷计价；官网调价后重新点一次即可。
- 插件对**所有模型使用同一组单价**，不按模型分别定价；模型明细里的金额也按同一组单价折算。
- 统计范围是 `<DSH_HOME>/sessions` 下本机持久化的会话；不包含其他设备、其他浏览器端
  或未落盘的用量。`DSH_HOME` 默认是 `~/.dsh`，可用环境变量覆盖。
- 周窗口按**本机时区**计算：从每周起始日（默认周一）00:00 起算 7 天，跨周自动清零。

## 安装

### 前置条件

- DeepSeek Harness 0.2.x 的 Web 版本（已启用 `dsh-web-app` 与插件管理器相关 bundle）。
- 插件目录里直接包含 `package.json` 与 `cordis.patch.yml`。
- 找到你的 profile：默认是 `desktop`，对应 `C:\Users\<你>\.dsh\profiles\desktop`。
  下文用 `%DSH_HOME%` 表示 Harness 主目录（默认 `C:\Users\<你>\.dsh`）。

### 方式一：从本地目录安装（开发 / 离线）

以插件源码放在 `<你的插件目录>` 为例。

1. **备份** profile 的 `package.json`：

   ```powershell
   Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" \
             "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak"
   ```

2. **注册依赖**。二选一：

   - 用 CLI（会转发给 pnpm，自动写入 `dependencies`）：

     ```powershell
     dsh plugin --profile desktop add "link:<你的插件目录>"
     ```

     如果 `dsh` 不在 PATH 中，用完整路径（Windows 安装包的默认位置；实测该目录下存在
     `dsh.cmd`，可正常转发 `plugin` 子命令到 pnpm）：

     ```powershell
     & "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<你的插件目录>"
     ```

   - 或手工编辑 `%DSH_HOME%\profiles\desktop\package.json`，只加两处：

     ```jsonc
     "dependencies": {
       // ...其它插件不动...
       "dsh-weekly-budget": "link:<你的插件目录>"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ...其它 bundle 不动...
           "dsh-weekly-budget"
         ]
       }
     }
     ```

3. **安装依赖**（手工编辑时必须执行；用 CLI `add` 可跳过）：

   ```powershell
   dsh plugin --profile desktop install
   ```

   `link:` 会在 profile 的 `node_modules` 下建立指向源码目录的链接，之后改源码不需要重装。

4. **重启 Harness，再刷新页面**。Host 端代码（`index.js`）只在应用启动时加载，
   安装完成后必须完整重启一次 Harness；重启后刷新浏览器页面，输入框下方才会出现胶囊。

### 方式二：从 GitHub 安装

仓库：<https://github.com/wuyp0731/dsh-weekly-budget>

```powershell
dsh plugin --profile desktop add "github:wuyp0731/dsh-weekly-budget"
```

然后在 profile 的 `package.json` 中把 `"dsh-weekly-budget"` 追加进 `dsh.profile.bundles`
（CLI 不会自动改这里），重启 Harness 并刷新页面。

在 Harness 会话里也可以让 Agent 用插件管理器完成同样的两步：
`action = install_bundle`、`target = github:wuyp0731/dsh-weekly-budget`。

### 校验是否装好

- `%DSH_HOME%\profiles\desktop\node_modules\dsh-weekly-budget\package.json` 存在；
- 重启后 `%DSH_HOME%\storages\weekly-budget\summary.json` 会在一轮扫描后生成；
- 刷新页面，输入框下方出现「每周额度」胶囊。

### 关于 schemastery 依赖

Host 半端用 `@deepseek-ai/schemastery` 声明配置。插件通过 `createRequire` 依次尝试
`@deepseek-ai/schemastery`、profile 的 `node_modules` 等候选路径加载，所以 `link:`
方式安装也能正常工作（不要求把 schemastery 复制进插件目录）。

如果 Host 日志出现 `[weekly-budget] schemastery 不可用`，说明候选路径都没找到该包，可以：

- 在插件目录下建链接：`node_modules/@deepseek-ai/schemastery` 指向 profile 的
  `node_modules/@deepseek-ai/schemastery`；或
- 把插件复制（而不是 `link:`）进 profile 的 `node_modules`，让它按普通包解析依赖。

## 使用

### 胶囊

- 位置：输入框下方独立的统计行（`conversation.composer.dock`，容器 `justify-content: center; gap: 12px`），
  与 ui-chat 的 token 用量、轮次统计胶囊同一行；不是输入框内、也不是模型/日期控件那一行。
- 显示：`每周额度  ¥12.34 / ¥50.00` + 进度条；数据为空时显示 `¥0.00 / ¥上限`。
- 颜色：`ok`（<80%）品牌色、`warn`（80%–100%）警告色、`over`（≥100%）错误色。
- 点击打开明细弹窗，`Esc` 或点击弹窗外关闭。

### 弹窗

弹窗内自上而下：标题与金额、周范围、大进度条与百分比、明细（剩余额度、请求次数、
输入/缓存命中/输出 token、本周会话数）、配置区、模型明细、底部更新时间与「刷新」。

配置区里「峰价」折叠展开后，除了四个单价输入，还有 **「同步官网定价」** 按钮：
它按本周用量最大的模型取官网价格快照（2026-10-17）的峰价写入四个字段，同时把
`peakPricingEnabled` 打开、`offPeakRatio` 设为 0.5，并提示同步到的模型名。

可修改的配置：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `weeklyLimit` | number | 50 | 每周消费上限（元）。`number` 输入，保存后立即影响进度条与状态色。 |
| `weekStartsOn` | `monday` / `sunday` | `monday` | 每周起始日，按本机时区 00:00 起算。修改后立即重算周窗口。 |
| `inputPrice` | number | 2 | 未缓存输入**峰价**（元/百万 token，官网 deepseek-flash）。 |
| `cacheReadPrice` | number | 0.04 | 缓存命中输入**峰价**（元/百万 token）。 |
| `cacheWritePrice` | number | 0 | 缓存写入**峰价**（DeepSeek 不单独收费，保持 0）。 |
| `outputPrice` | number | 8 | 输出**峰价**（元/百万 token）。 |
| `peakPricingEnabled` | boolean | `true` | 打开峰谷计价：空闲时段按 `offPeakRatio` 折算。 |
| `offPeakRatio` | number | 0.5 | 空闲时段折扣率（官网口径：空闲价 = 高峰价一半）。 |
| `refreshSeconds` | number | 20 | Host 侧后台重算间隔（秒，5–600）。非热更新字段，改后需重启生效。 |
| `enabled` | boolean | `true` | 关闭后胶囊隐藏、Host 侧停止统计。 |

配置写入 profile 的配置层（`%DSH_HOME%\profiles\desktop\cordis.patch.yml` 中
`id: weekly-budget` 的条目），刷新页面或重启后仍然生效。

> 提示：单价为 0 时对应项不计费；上限设为 0 时进度条按「有花费即超支」处理。

### summary.json

Host 侧写出的汇总文件（`version: 1`），供前端读取，也方便脚本核对：

```json
{
  "version": 1,
  "generatedAt": 1792584979911,
  "timeZone": "Asia/Shanghai",
  "weekStartsOn": "monday",
  "weekStart": 1792339200000,
  "weekEnd": 1792944000000,
  "currency": "CNY",
  "limit": 50,
  "used": 3.482381,
  "remaining": 46.517619,
  "ratio": 0.069648,
  "percent": 7,
  "status": "ok",
  "requests": 431,
  "tokens": { "input": 622467, "cacheRead": 59117952, "cacheWrite": 0, "output": 407492 },
  "models": [
    { "provider": "deepseek-account", "model": "deepseek-flash", "requests": 431,
      "tokens": { "input": 622467, "cacheRead": 59117952, "cacheWrite": 0, "output": 407492 },
      "cost": 3.482381 }
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
  "scanned": { "sessions": 24, "files": 24, "durationMs": 223 }
}
```

> 上面是**结构示例**（数值仅用于说明字段含义，不是任何人的真实账单）。实际运行时
> `weekStart` 是本周起始日 00:00 的本地时间毫秒，金额按官网峰谷价折算；`billing.effective`
> 给出本次实际使用的峰价/空闲价，方便核对。

- 金额保留 6 位小数；`percent` 保留 1 位。
- `ratio = used / limit`；`limit <= 0` 时为 `null`。
- `status`：`ok` / `warn`（≥80%）/ `over`（≥100%）。
- `scanned` 是本次扫描的会话文件数与耗时（调试用）。

## 限制

- **只覆盖本机**：只统计 `<DSH_HOME>/sessions` 下持久化的会话日志；其他设备、
  其他 Harness 实例的独立主目录、未落盘或已被清理的会话都不在统计内。
- **只统计 usage 事件**：只有带 `data.usage` 的 `assistant/message` 事件参与折算；
  旧版本日志或缺少 usage 的事件会被跳过。
- **估算而非账单**：不区分模型单价、不处理赠送额度/汇率；峰谷按固定时段计算，
  识别不了中国法定节假日（官网按空闲价，插件会按高峰价，略偏高）。与官方账单对不上是正常的。
- **有延迟**：只有 Host 会计算并写 summary——启动时算一次，之后每 `refreshSeconds`
  （默认 20 秒）重算一次；前端**只读**：挂载时读一次，之后每 15 秒轮询一次，并在窗口
  重新获得焦点时再读。刚结束的请求可能最多延迟约半分钟才反映。
- **依赖日志格式**：会话日志是「多条 zstd 帧串联」的 JSONL，插件自行逐帧解压；
  尾部撕裂缝会被忽略，不影响其它帧。未来日志格式大改可能导致统计为 0。
- **仅 Web GUI**：客户端半端依赖 `slots`、`configForms`、`remote.workspaceFiles`、`locale`
  等服务，不适用于 TUI/CLI。
- **不联网**：插件不会把用量数据发到任何地方。

## 卸载

1. 从 `%DSH_HOME%\profiles\desktop\package.json` 的 `dsh.profile.bundles` 中删除
   `"dsh-weekly-budget"`。
2. 移除依赖（任选其一）：

   ```powershell
   dsh plugin --profile desktop remove dsh-weekly-budget
   ```

   或手工从 `dependencies` 里删掉 `"dsh-weekly-budget"` 后执行
   `dsh plugin --profile desktop install`。

3. 重启 Harness 并刷新页面。
4. （可选）删除汇总文件 `%DSH_HOME%\storages\weekly-budget\`，以及 profile 配置里
   `id: weekly-budget` 的条目。

插件不改动会话日志，卸载不会丢失任何对话数据。

## 开发

### 目录结构

```text
dsh-weekly-budget/
├── package.json          # 插件清单（dsh.bundle / dsh.client 元数据）
├── cordis.patch.yml      # bundle patch，insert id = weekly-budget
├── index.js              # Host 半端：扫描会话日志、峰谷折算、写 summary.json
├── client.js             # Client 半端：dock 胶囊、弹窗、配置读写
├── locale/{zh,en}.json   # 插件管理器中显示的名称与描述
├── icon.svg              # 插件图标
├── docs/CONTRACT.md      # 实现契约（数据格式与验收标准的唯一真源）
├── tools/
│   ├── verify-stats.mjs  # 用真实会话日志跑一遍统计
│   ├── verify-apply.mjs  # mock ctx 跑 apply()，验证 summary 写盘
│   ├── verify-static.mjs # 静态契约检查（inject / slot / 字典 / 主题变量）
│   └── inspect-peak-calls.mjs # 峰谷归属分布与边界差异诊断
└── README.md
```

### 本地检查

```powershell
node --check index.js
node --check client.js
node tools/verify-static.mjs         # 静态契约检查（不需要浏览器）
node tools/verify-stats.mjs          # 用真实 ~/.dsh/sessions 跑一遍统计
node tools/verify-apply.mjs          # mock ctx 跑 apply()，验证 summary.json 写盘
node tools/inspect-peak-calls.mjs    # 本周每次调用的峰谷归属与边界差异
```

### 实现要点

- **Host 侧**不依赖其它服务：自行枚举 `sessions/*/*/session*.jsonl.zstd`（每个会话取
  版本号最高的规范文件）并逐帧解压。解析结果按文件 `(size, mtimeMs)` 缓存，
  文件不变不重读；配置变化（`loader/volatile-update`）与定时器触发重算。
- **Client 侧**通过 `window.__ModuleLoader__.load` 注册，向 `conversation.composer.dock`
  注入条目，用 `ctx.configForms.get('weekly-budget')` 读写配置，用
  `ctx.remote.workspaceFiles.read` 读取 summary，每 15 秒与窗口重新聚焦时刷新。
- **配置依赖**：Host 半端用 `createRequire` 兜底加载 `@deepseek-ai/schemastery`，
  本地 `link:` 安装时也能从 profile 的 `node_modules` 找到依赖；找不到时日志会打印
  `[weekly-budget] schemastery 不可用`，处理方式见「安装 → 关于 schemastery 依赖」。
- 两端不引入第三方库；样式只用 `--dsw-*` 主题变量。
- 调试：设置环境变量 `DSH_WEEKLY_BUDGET_DEBUG=1` 后重启，Host 控制台会打印每次刷新
  的金额、请求数与耗时。

## 兼容性

- 面向 DeepSeek Harness **0.2.x Web** 版本（开发时基于 0.2.1-rc.2）。
- Host 半端依赖 Node 24 内置的 `zlib.zstdDecompressSync`。
- 客户端半端依赖 `slots`、`configForms`、`locale`、`remote.workspaceFiles` 服务；
  Harness 升级后如这些服务签名变化，插件需要同步更新。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 输入框下方没有胶囊 | 确认 `bundles` 已包含 `dsh-weekly-budget`、`node_modules/dsh-weekly-budget` 存在，然后**重启** Harness 并刷新页面。 |
| 胶囊显示 `¥0.00` 且一直不涨 | 检查 `summary.json` 是否生成；确认本周有带 usage 的会话；确认 `DSH_HOME` 指向实际主目录。 |
| 金额和官方账单差很多 | 正常：峰谷、节假日、赠送额度都无法完全还原；先点「同步官网定价」，再按实际模型调整峰价。 |
| 改了上限但进度条没变 | 保存失败会回滚并提示；确认配置已写入 profile，必要时重启后再试。 |
| 弹窗提示读取失败 | 通常是 summary 尚未生成或路径不存在；首次安装后等一次扫描，或点「刷新」。 |
| 从本地链接切到 GitHub 版本报 `ERR_PNPM_EPERM` | 删除残留的 `node_modules\dsh-weekly-budget` 链接目录（junction）后重试。 |
| Host 日志出现 `[weekly-budget] schemastery 不可用` | 在插件目录建 `node_modules/@deepseek-ai/schemastery` 链接，或改用复制安装，见「关于 schemastery 依赖」。 |

## 许可

插件代码目前仅在本机开发使用；发布到 GitHub 前请补充仓库地址与 LICENSE。
