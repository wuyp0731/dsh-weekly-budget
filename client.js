/**
 * dsh-weekly-budget · client half（浏览器侧）
 *
 * 在输入框下方的 conversation.composer.dock 里加一颗「每周额度」胶囊：两行文字
 * （本周已用 / 上限）加一条 3px 进度条；点击用 react-dom 的 portal 打开配置弹窗，
 * 可改每周上限、每周起始日与四个单价。
 *
 * 状态来源（契约 docs/CONTRACT.md §4）：
 *   - 配置：ctx.configForms.get('weekly-budget')，getSnapshot().value 读、set(field, value) 写；
 *     命名空间必须与 cordis.patch.yml 的 entry id 一致。
 *   - 用量：ctx.remote.workspaceFiles.read(sessionId, path, {}, signal) 读 host 侧写下的
 *     summary.json；sessionId 只作授权通道（槽位是 session 作用域，渲染器注入
 *     props.sessionId），统计内容本身是本机全部会话的汇总，不随当前会话变化。
 *
 * 只依赖 react / react-dom，样式全部使用 --dsw-* 主题变量，类名统一 wb- 前缀。
 */
window.__ModuleLoader__.load({
  id: 'dsh-weekly-budget',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /** 承载配置的 profile entry id，必须与 cordis.patch.yml / host Config 完全一致。 */
    const NAMESPACE = 'weekly-budget';
    /** 本插件的字典命名空间（槽位注册时声明，渲染器注入 t）。 */
    const LOCALE_NS = 'weekly-budget';
    /** 输入框下方的居中 dock 槽位。 */
    const DOCK_SLOT = 'conversation.composer.dock';
    /** summary.json 相对 <DSH_HOME> 的位置。 */
    const SUMMARY_RELATIVE = 'storages/weekly-budget/summary.json';
    /** 轮询间隔（毫秒）。 */
    const POLL_MS = 15000;
    /** 弹窗与视口边缘的最小距离。 */
    const PANEL_MARGIN = 12;
    /** 弹窗与胶囊之间的间距。 */
    const PANEL_GAP = 8;
    /** 模型明细最多直接列出的行数，其余折成「等 N 个模型」。 */
    const MAX_MODELS = 8;
    /** host 未送来配置时的 schema 默认值，仅用于首帧兜底。 */
    const DEFAULT_CONFIG = {
      enabled: true,
      weeklyLimit: 50,
      weekStartsOn: 'monday',
      // 官网 deepseek-flash 高峰价（元/百万 token）：缓存命中 0.04、未命中 2、输出 8；无缓存写入费。
      inputPrice: 2,
      cacheReadPrice: 0.04,
      cacheWritePrice: 0,
      outputPrice: 8,
      peakPricingEnabled: true,
      offPeakRatio: 0.5,
    };

    /**
     * 官网定价快照（元/百万 token，峰价）。
     * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
     * 官网规定空闲时段价格是高峰价的一半，所以只存峰价，空闲价由 offPeakRatio 折算。
     */
    const OFFICIAL_PRICING = {
      updated: '2026-10-17',
      source: 'api-docs.deepseek.com/zh-cn/quick_start/pricing',
      offPeakRatio: 0.5,
      fallback: 'deepseek-flash',
      models: {
        'deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
        'deepseek-v4-pro': { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
      },
    };

    /** 未定位时的量测样式：布局存在但不可见（与 ui-chat 的 stat-dialog 一致）。 */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /** 简体中文字典（键集真源）。 */
    const zh = {
      'pill.label': '每周额度',
      'amount.pair': '¥{used} / ¥{limit}',
      'pill.aria': '每周额度：已用 {used}，上限 {limit}，进度 {percent}',
      'pill.ariaLoading': '每周额度：上限 {limit}，本周用量仍在统计',
      'dialog.title': '每周额度',
      'dialog.range': '{start} – {end}',
      'dialog.percent': '{percent}%',
      'dialog.remaining': '剩余额度',
      'dialog.requests': '请求次数',
      'dialog.input': '输入 tokens',
      'dialog.cacheRead': '缓存命中 tokens',
      'dialog.output': '输出 tokens',
      'dialog.sessions': '本周会话',
      'dialog.limit': '本周上限',
      'dialog.weekStart': '每周起始',
      'dialog.monday': '周一',
      'dialog.sunday': '周日',
      'dialog.prices': '峰价（元/百万 token）',
      'dialog.priceInput': '输入',
      'dialog.priceCacheRead': '缓存命中',
      'dialog.priceCacheWrite': '缓存写入',
      'dialog.priceOutput': '输出',
      'dialog.syncPricing': '同步官网定价',
      'dialog.syncSynced': '已同步 {model} 官网价',
      'dialog.syncHint': '峰价：工作日 9–12、14–18（北京时间）；空闲时段自动半价',
      'dialog.syncSource': '价格快照 {source}（{date}），官网调价后请重新同步',
      'dialog.save': '保存',
      'dialog.saved': '已保存',
      'dialog.saveFailed': '保存失败，请重试',
      'dialog.readonly': '当前配置只读，无法保存',
      'dialog.invalidNumber': '请输入不小于 0 的数字',
      'dialog.models': '模型明细',
      'dialog.moreModels': '等 {count} 个模型',
      'dialog.updatedAt': '更新于 {time}',
      'dialog.notUpdated': '尚未更新',
      'dialog.refresh': '刷新',
      'dialog.estimate': '按本机会话用量折算，非官方账单',
      'dialog.noSummary': '还没有本周用量数据，宿主统计写入后会自动出现。',
      'dialog.waiting': '正在等待宿主统计…',
      'dialog.noSession': '还没有可读取的会话。',
      'dialog.error': '读取用量失败：{message}',
    };

    /** English dictionary; keys must match the zh key set exactly. */
    const en = {
      'pill.label': 'Weekly budget',
      'amount.pair': '¥{used} / ¥{limit}',
      'pill.aria': 'Weekly budget: {used} used of {limit}, {percent}',
      'pill.ariaLoading': 'Weekly budget: cap {limit}, usage still being tallied',
      'dialog.title': 'Weekly budget',
      'dialog.range': '{start} – {end}',
      'dialog.percent': '{percent}%',
      'dialog.remaining': 'Remaining',
      'dialog.requests': 'Requests',
      'dialog.input': 'Input tokens',
      'dialog.cacheRead': 'Cache-hit tokens',
      'dialog.output': 'Output tokens',
      'dialog.sessions': 'Sessions this week',
      'dialog.limit': 'Weekly cap',
      'dialog.weekStart': 'Week starts on',
      'dialog.monday': 'Monday',
      'dialog.sunday': 'Sunday',
      'dialog.prices': 'Peak prices (CNY per million tokens)',
      'dialog.priceInput': 'Input',
      'dialog.priceCacheRead': 'Cache read',
      'dialog.priceCacheWrite': 'Cache write',
      'dialog.priceOutput': 'Output',
      'dialog.syncPricing': 'Sync official prices',
      'dialog.syncSynced': 'Synced official {model} prices',
      'dialog.syncHint': 'Peak prices: Mon–Fri 09:00–12:00 and 14:00–18:00 (UTC+8); off-peak is automatically half price',
      'dialog.syncSource': 'Price snapshot {source} ({date}); re-sync when DeepSeek updates its page',
      'dialog.save': 'Save',
      'dialog.saved': 'Saved',
      'dialog.saveFailed': 'Save failed, please retry',
      'dialog.readonly': 'This configuration is read-only',
      'dialog.invalidNumber': 'Enter a number that is 0 or greater',
      'dialog.models': 'Per-model breakdown',
      'dialog.moreModels': 'and {count} more models',
      'dialog.updatedAt': 'Updated {time}',
      'dialog.notUpdated': 'Not updated yet',
      'dialog.refresh': 'Refresh',
      'dialog.estimate': 'Estimated from local session usage; not an official bill',
      'dialog.noSummary': 'No weekly usage yet; it appears once the host writes its summary.',
      'dialog.waiting': 'Waiting for host statistics…',
      'dialog.noSession': 'No session to read yet.',
      'dialog.error': 'Could not read usage: {message}',
    };

    /** 注入一次样式；复用 ui-chat 的 data-plugin-css 去重约定。 */
    const CSS = `
.wb-anchor{display:inline-flex;min-width:0;max-width:100%}
.wb-pill{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;width:min(220px,100%);height:30px;margin:0;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:15px;cursor:pointer;text-align:left}
.wb-pill:hover,.wb-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.wb-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wb-row{display:flex;align-items:baseline;gap:6px;min-width:0}
.wb-name{flex:none;white-space:nowrap}
.wb-amount{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
.wb-bar{display:block;position:relative;height:3px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.wb-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.wb-fill[data-status="warn"]{background:var(--dsw-alias-state-warn-primary,#e6a23c)}
.wb-fill[data-status="over"]{background:var(--dsw-alias-state-error-primary,#e5484d)}
.wb-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(150%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(150%));background-clip:padding-box;isolation:isolate;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:default}
.wb-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:2px;color:var(--dsw-alias-label-primary);font-weight:500}
.wb-titleMain{display:inline-flex;align-items:center;gap:6px;min-width:0}
.wb-whale{flex:none;font-size:14px;line-height:18px}
.wb-headValue{flex:none;font-variant-numeric:tabular-nums}
.wb-range{margin-bottom:10px;color:var(--dsw-alias-label-tertiary)}
.wb-progressRow{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.wb-progressTrack{position:relative;flex:1 1 auto;height:8px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.wb-progressFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.wb-progressFill[data-status="warn"]{background:var(--dsw-alias-state-warn-primary,#e6a23c)}
.wb-progressFill[data-status="over"]{background:var(--dsw-alias-state-error-primary,#e5484d)}
.wb-percent{flex:none;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wb-details{display:grid;grid-template-columns:minmax(72px,auto) minmax(0,1fr);gap:6px 16px;margin:0 0 12px}
.wb-details dt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.wb-details dd{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);text-align:right;font-variant-numeric:tabular-nums}
.wb-field{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:8px}
.wb-label{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.wb-input{box-sizing:border-box;flex:1 1 auto;min-width:0;width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-variant-numeric:tabular-nums}
.wb-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.wb-select{box-sizing:border-box;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.wb-button{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.wb-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.wb-button:disabled{opacity:.5;cursor:default}
.wb-buttonPrimary{border-color:var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary)}
.wb-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wb-notice{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.wb-notice[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.wb-fold{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:4px;padding-top:8px}
.wb-foldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;margin:0 0 6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.wb-foldHead:hover{color:var(--dsw-alias-label-secondary)}
.wb-chevron{display:inline-block;transition:transform .15s}
.wb-chevron[data-open="true"]{transform:rotate(90deg)}
.wb-priceGrid{display:flex;flex-direction:column;gap:8px;margin-top:2px}
.wb-priceRow{display:flex;align-items:center;gap:8px;min-width:0}
.wb-priceLabel{flex:none;width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.wb-priceHint{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.wb-priceSource{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;opacity:.8;overflow-wrap:anywhere}
.wb-models{display:flex;flex-direction:column;gap:4px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:8px}
.wb-modelsTitle{color:var(--dsw-alias-label-tertiary)}
.wb-modelRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.wb-modelName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.wb-modelCost{flex:none;font-variant-numeric:tabular-nums}
.wb-more{color:var(--dsw-alias-label-tertiary)}
.wb-error{margin:2px 0 8px;color:var(--dsw-alias-state-error-primary,#e5484d);overflow-wrap:anywhere}
.wb-note{margin:2px 0 8px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.wb-estimate{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.wb-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:10px}
.wb-updated{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: reduce){.wb-fill,.wb-progressFill,.wb-chevron{transition:none}}
`;

    /** 把中文值里的 {key} 换成参数值，供没有 t 的兜底渲染使用。 */
    function interpolate(template, params) {
      const source = String(template);
      if (params === undefined || params === null) return source;
      let result = '';
      let index = 0;
      while (index < source.length) {
        const open = source.indexOf('{', index);
        if (open < 0) {
          result += source.slice(index);
          break;
        }
        const close = source.indexOf('}', open + 1);
        if (close < 0) {
          result += source.slice(index);
          break;
        }
        const key = source.slice(open + 1, close);
        result += source.slice(index, open);
        result += Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : source.slice(open, close + 1);
        index = close + 1;
      }
      return result;
    }

    /** 兜底翻译：渲染器没注入 t 时退回中文，保证不出现原始键名。 */
    function fallbackTranslate(key, params) {
      const template = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
      return interpolate(template, params);
    }

    /** 有限数字才算数，其余当 undefined，交给下一级兜底。 */
    function numberValue(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    /** 依次取第一个有限数字；最后一项是默认值。 */
    function firstNumber() {
      for (let index = 0; index < arguments.length; index += 1) {
        const candidate = arguments[index];
        if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
      }
      return 0;
    }

    /** 金额数字文本：常规两位小数，极小的非零值给四位，避免都显示成 0.00。 */
    function formatAmount(value) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      const magnitude = Math.abs(amount);
      if (magnitude > 0 && magnitude < 0.01) return amount.toFixed(4);
      return amount.toFixed(2);
    }

    /** 带币种的金额文本，负数写成 -¥x.xx。 */
    function formatMoney(value) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      return (amount < 0 ? '-¥' : '¥') + formatAmount(Math.abs(amount));
    }

    /** 百分比数字文本（一位小数，整数去掉 .0）。 */
    function formatPercentNumber(value) {
      const percent = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      return String(Math.round(percent * 10) / 10);
    }

    /** 紧凑 token 数：517 / 12.2K / 1.2M。 */
    function formatCompactTokens(value) {
      const tokens = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      const scaled = (candidate) => {
        const text = candidate.toFixed(1);
        return text.endsWith('.0') ? text.slice(0, -2) : text;
      };
      if (tokens < 1000) return String(Math.round(tokens));
      if (tokens < 1e6) return scaled(tokens / 1e3) + 'K';
      return scaled(tokens / 1e6) + 'M';
    }

    /** 整数计数文本。 */
    function formatCount(value) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      return String(Math.round(count));
    }

    /** HH:mm:ss。 */
    function formatClock(ms) {
      const date = new Date(ms);
      const pad = (value) => (value < 10 ? '0' + value : String(value));
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /** 本地化「10月19日 / Oct 19」；格式化器只建一次。 */
    let dayFormatter;
    function formatDay(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      if (dayFormatter === undefined) {
        try {
          dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
        } catch (error) {
          dayFormatter = null;
        }
      }
      const date = new Date(ms);
      if (dayFormatter !== null) {
        try {
          return dayFormatter.format(date);
        } catch (error) {
          // 落到手工格式。
        }
      }
      return (date.getMonth() + 1) + '/' + date.getDate();
    }

    /** 把 summary 里的日期字段归一成毫秒：>=1e11 视为 ms，>=1e9 视为秒。 */
    function pickMillis(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
      if (value >= 1e11) return value;
      if (value >= 1e9) return value * 1000;
      return undefined;
    }

    /** 本地时区里 weekStartsOn 当天 00:00 的毫秒与一周后的 00:00。 */
    function localWeekWindow(weekStartsOn, referenceMs) {
      const start = new Date(typeof referenceMs === 'number' && Number.isFinite(referenceMs) ? referenceMs : Date.now());
      start.setHours(0, 0, 0, 0);
      const targetDay = weekStartsOn === 'sunday' ? 0 : 1;
      const offset = (start.getDay() - targetDay + 7) % 7;
      start.setDate(start.getDate() - offset);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 6);
      return { start: start.getTime(), end: end.getTime() };
    }

    /** 把 Windows 反斜杠统一成正斜杠，并去掉尾部斜杠（不用正则，避免转义歧义）。 */
    function toSlashes(value) {
      const separator = String.fromCharCode(92);
      const text = String(value);
      let result = '';
      for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        result += char === separator ? '/' : char;
      }
      let end = result.length;
      while (end > 0 && result.charAt(end - 1) === '/') end -= 1;
      return result.slice(0, end);
    }

    /** 拼接路径，统一正斜杠，避免 Windows 混合分隔符。 */
    function joinPath(base, relative) {
      const head = toSlashes(base);
      let tail = String(relative);
      while (tail.length > 0 && tail.charAt(0) === '/') tail = tail.slice(1);
      return tail === '' ? head : head + '/' + tail;
    }

    /**
     * summary.json 的候选绝对路径（契约 §4 的顺序）。
     * hostHome 已经是 .dsh 数据目录时跳过加倍的 .dsh 层。
     */
    function summaryPaths(hostHome) {
      const home = toSlashes(hostHome);
      const lower = home.toLowerCase();
      if (lower.endsWith('/.dsh') || lower.endsWith(':/.dsh')) {
        return [joinPath(home, SUMMARY_RELATIVE)];
      }
      return [joinPath(home, '.dsh/' + SUMMARY_RELATIVE), joinPath(home, SUMMARY_RELATIVE)];
    }

    /** 从任意抛出物里取一条可读消息。 */
    function errorMessage(error) {
      if (error instanceof Error && error.message !== '') return error.message;
      if (typeof error === 'string' && error !== '') return error;
      if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    /** 取 configForms 表单快照；form 缺席时返回 undefined。 */
    function snapshotOf(form) {
      if (form === undefined || form === null || typeof form.getSnapshot !== 'function') return undefined;
      try {
        return form.getSnapshot();
      } catch (error) {
        return undefined;
      }
    }

    /**
     * 把 form 快照归一成配置；host 未就绪的字段留 undefined，由 summary 与默认值兜底。
     * @returns {{snapshot: any, enabled: boolean, writable: (boolean|undefined), weeklyLimit: (number|undefined), weekStartsOn: ('monday'|'sunday'|undefined), inputPrice: (number|undefined), cacheReadPrice: (number|undefined), cacheWritePrice: (number|undefined), outputPrice: (number|undefined)}}
     */
    function readConfig(form) {
      const snapshot = snapshotOf(form);
      let value;
      if (snapshot !== undefined && snapshot !== null && typeof snapshot.value === 'object' && snapshot.value !== null) {
        value = snapshot.value;
      }
      const field = (name) => (value === undefined ? undefined : value[name]);
      const startsOn = field('weekStartsOn');
      return {
        snapshot: snapshot,
        enabled: typeof field('enabled') === 'boolean' ? field('enabled') : DEFAULT_CONFIG.enabled,
        writable: snapshot === undefined || snapshot === null ? undefined : snapshot.writable !== false,
        weeklyLimit: numberValue(field('weeklyLimit')),
        weekStartsOn: startsOn === 'sunday' ? 'sunday' : (startsOn === 'monday' ? 'monday' : undefined),
        inputPrice: numberValue(field('inputPrice')),
        cacheReadPrice: numberValue(field('cacheReadPrice')),
        cacheWritePrice: numberValue(field('cacheWritePrice')),
        outputPrice: numberValue(field('outputPrice')),
        peakPricingEnabled: typeof field('peakPricingEnabled') === 'boolean' ? field('peakPricingEnabled') : undefined,
        offPeakRatio: numberValue(field('offPeakRatio')),
      };
    }

    /**
     * 取 props 里的授权会话 id。槽位是 session 作用域，渲染器保证注入 `sessionId`；
     * 它只用于 workspaceFiles.read 的会话授权，不决定统计范围（统计范围是本机全部会话）。
     * @param props - 插槽渲染器注入的 props。
     * @returns 非空字符串或 undefined。
     */
    function sessionIdOf(props) {
      return typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined;
    }

    /**
     * 按候选路径读 summary.json。
     * @returns {Promise<{status: string, data?: object, message?: string}>} status: ok|missing|waiting|no-session|error|aborted
     */
    async function fetchSummary(files, hostHome, sessionId, signal) {
      if (files === undefined || files === null || typeof files.read !== 'function') return { status: 'waiting' };
      if (typeof sessionId !== 'string' || sessionId === '') return { status: 'no-session' };
      if (typeof hostHome !== 'string' || hostHome === '') return { status: 'waiting' };
      const candidates = summaryPaths(hostHome);
      let failure = null;
      let sawMissing = false;
      for (const path of candidates) {
        if (signal !== undefined && signal.aborted) return { status: 'aborted' };
        let result;
        try {
          result = await files.read(sessionId, path, {}, signal);
        } catch (error) {
          if (signal !== undefined && signal.aborted) return { status: 'aborted' };
          failure = errorMessage(error);
          continue;
        }
        if (result !== null && typeof result === 'object' && result.ok === true) {
          const text = result.value !== null && result.value !== undefined ? result.value.text : undefined;
          if (typeof text !== 'string') {
            failure = 'summary.json has no text field';
            continue;
          }
          try {
            const data = JSON.parse(text);
            if (data !== null && typeof data === 'object' && !Array.isArray(data)) return { status: 'ok', data: data };
            failure = 'summary.json is not an object';
          } catch (error) {
            failure = errorMessage(error);
          }
          continue;
        }
        const details = result !== null && typeof result === 'object' && result.error !== null && result.error !== undefined ? result.error : undefined;
        const code = details !== undefined ? details.code : undefined;
        if (code === 'workspace-file/not-found') {
          sawMissing = true;
          continue;
        }
        const message = details !== undefined && typeof details.message === 'string' ? details.message : undefined;
        failure = code !== undefined && message !== undefined ? code + ': ' + message : (message !== undefined ? message : 'workspaceFiles.read failed');
      }
      if (failure !== null) return { status: 'error', message: failure };
      if (sawMissing) return { status: 'missing' };
      return { status: 'waiting' };
    }

    /**
     * 注入一次全局样式（按 data-plugin-css 去重），返回移除函数。
     * 样式在 apply 里通过 ctx.effect 管理，插件卸载时随 fiber 一并清除。
     */
    function installCss() {
      if (typeof document === 'undefined' || document.head === null) return () => {};
      const tagId = 'dsh-weekly-budget/client.css';
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';
      if (document.querySelector(selector) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-weekly-budget';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    const inject = ['slots', 'configForms', 'locale', 'remote', 'remote.workspaceFiles'];

    function apply(ctx) {
      // 样式与字典都是本插件资源：注册在 apply 内、随 fiber 释放。
      const registerStyles = () => installCss();
      if (typeof ctx.effect === 'function') ctx.effect(registerStyles, 'weekly-budget: styles');
      else registerStyles();

      const form = ctx.configForms !== undefined && ctx.configForms !== null && typeof ctx.configForms.get === 'function'
        ? ctx.configForms.get(NAMESPACE)
        : undefined;
      const remote = ctx.remote !== undefined && ctx.remote !== null ? ctx.remote : undefined;
      const workspaceFiles = remote !== undefined ? remote.workspaceFiles : undefined;

      // 字典随本插件 fiber 释放；t 由插槽渲染器注入。
      const registerDictionaries = () => ctx.locale.register(LOCALE_NS, { zh: zh, en: en });
      if (typeof ctx.effect === 'function') ctx.effect(registerDictionaries, 'weekly-budget: dictionaries');
      else registerDictionaries();

      /** 读 host 事实里的 home；首个 ready 帧之前可能还是 undefined。 */
      function readHostHome() {
        if (remote === undefined) return undefined;
        const facts = remote.$host;
        if (facts === undefined || facts === null) return undefined;
        const home = facts.home;
        return typeof home === 'string' && home !== '' ? home : undefined;
      }

      /** 写一个配置字段；返回 Promise<boolean>，false / 异常都表示 host 没接受。 */
      function writeField(field, value) {
        if (form === undefined || form === null || typeof form.set !== 'function') return Promise.resolve(false);
        let pending;
        try {
          pending = form.set(field, value);
        } catch (error) {
          return Promise.resolve(false);
        }
        if (pending !== undefined && pending !== null && typeof pending.then === 'function') {
          return pending.then((accepted) => accepted !== false, () => false);
        }
        return Promise.resolve(true);
      }

      /**
       * 输入框下方的「每周额度」胶囊 + 配置弹窗。
       * @param props - 渲染器注入的 t（locale 命名空间），可能还有 sessionId。
       */
      function WeeklyBudgetPill(props) {
        const t = typeof props.t === 'function' ? props.t : fallbackTranslate;

        // ── 配置：快照读 + subscribe 跟随 ────────────────────────────────
        const [, bumpConfig] = React.useState(0);
        React.useEffect(() => {
          if (form === undefined || form === null || typeof form.subscribe !== 'function') return undefined;
          const unsubscribe = form.subscribe(() => bumpConfig((value) => value + 1));
          return typeof unsubscribe === 'function' ? unsubscribe : undefined;
        }, []);
        const config = readConfig(form);

        // ── 会话：只用槽位注入的授权会话；统计内容本身是全机汇总 ────────────
        const sessionId = sessionIdOf(props);

        // ── 用量：挂载即读、15s 轮询、focus 刷新 ─────────────────────────
        const [summary, setSummary] = React.useState({ status: 'idle', data: null, error: null, fetchedAt: 0 });
        const abortRef = React.useRef(null);
        const load = React.useCallback(() => {
          const currentSessionId = typeof sessionId === 'string' ? sessionId : '';
          if (currentSessionId === '') {
            setSummary({ status: 'no-session', data: null, error: null, fetchedAt: 0 });
            return;
          }
          if (abortRef.current !== null) abortRef.current.abort();
          const controller = new AbortController();
          abortRef.current = controller;
          // 已有数据时静默刷新：不切到 loading，避免每 15 秒闪一次「正在等待宿主统计…」
          // 与刷新按钮的禁用态；新数据回来后再一次性替换。
          setSummary((previous) => (previous.data !== null
            ? previous
            : { status: 'loading', data: null, error: null, fetchedAt: 0 }));
          fetchSummary(workspaceFiles, readHostHome(), currentSessionId, controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            if (abortRef.current === controller) abortRef.current = null;
            if (result.status === 'ok') {
              setSummary({ status: 'ready', data: result.data, error: null, fetchedAt: Date.now() });
              return;
            }
            if (result.status === 'error') {
              setSummary({ status: 'error', data: null, error: result.message, fetchedAt: Date.now() });
              return;
            }
            if (result.status === 'missing') {
              setSummary({ status: 'missing', data: null, error: null, fetchedAt: Date.now() });
              return;
            }
            if (result.status === 'no-session') {
              setSummary({ status: 'no-session', data: null, error: null, fetchedAt: 0 });
              return;
            }
            if (result.status === 'aborted') return;
            setSummary({ status: 'waiting', data: null, error: null, fetchedAt: 0 });
          });
        }, [sessionId]);

        React.useEffect(() => {
          load();
        }, [load]);

        React.useEffect(() => {
          const timer = window.setInterval(() => {
            load();
          }, POLL_MS);
          const onFocus = () => load();
          window.addEventListener('focus', onFocus);
          return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', onFocus);
            if (abortRef.current !== null) {
              abortRef.current.abort();
              abortRef.current = null;
            }
          };
        }, [load]);

        // ── 弹窗状态与定位 ─────────────────────────────────────────────
        const [open, setOpen] = React.useState(false);
        const [pos, setPos] = React.useState(null);
        const anchorRef = React.useRef(null);
        const panelRef = React.useRef(null);

        React.useLayoutEffect(() => {
          if (!open) {
            setPos(null);
            return undefined;
          }
          const measure = () => {
            const anchor = anchorRef.current;
            const panel = panelRef.current;
            if (anchor === null || panel === null) return;
            const rect = anchor.getBoundingClientRect();
            const width = panel.offsetWidth;
            const height = panel.offsetHeight;
            const viewWidth = document.documentElement.clientWidth || window.innerWidth;
            const viewHeight = document.documentElement.clientHeight || window.innerHeight;
            let left = rect.left + rect.width / 2 - width / 2;
            const maxLeft = viewWidth - PANEL_MARGIN - width;
            if (left > maxLeft) left = maxLeft;
            if (left < PANEL_MARGIN) left = PANEL_MARGIN;
            let top = rect.top - height - PANEL_GAP;
            if (top < PANEL_MARGIN) top = rect.bottom + PANEL_GAP;
            const maxTop = viewHeight - PANEL_MARGIN - height;
            if (top > maxTop) top = maxTop;
            if (top < PANEL_MARGIN) top = PANEL_MARGIN;
            setPos((previous) => (previous !== null && previous.left === left && previous.top === top ? previous : { left: left, top: top }));
          };
          measure();
          const panel = panelRef.current;
          let observer;
          if (panel !== null && typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(measure);
            observer.observe(panel);
          }
          window.addEventListener('resize', measure);
          window.addEventListener('scroll', measure, true);
          return () => {
            if (observer !== undefined) observer.disconnect();
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
          };
        }, [open]);

        // Escape / 面板外指针或点击关闭；面板内与胶囊本身不关。
        React.useEffect(() => {
          if (!open) return undefined;
          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          };
          const isInside = (target) => (
            target instanceof Node
            && ((anchorRef.current !== null && anchorRef.current.contains(target))
              || (panelRef.current !== null && panelRef.current.contains(target)))
          );
          const onPointerDown = (event) => {
            if (!isInside(event.target)) setOpen(false);
          };
          const onClick = (event) => {
            if (!isInside(event.target)) setOpen(false);
          };
          document.addEventListener('keydown', onKeyDown, true);
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('click', onClick, true);
          return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('click', onClick, true);
          };
        }, [open]);

        // ── 表单草稿 / 提示 ────────────────────────────────────────────
        const [limitDraft, setLimitDraft] = React.useState('');
        const [priceDrafts, setPriceDrafts] = React.useState({ input: '', cacheRead: '', cacheWrite: '', output: '' });
        const [pricesOpen, setPricesOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [limitNotice, setLimitNotice] = React.useState(null);
        const [priceNotice, setPriceNotice] = React.useState(null);
        const [weekNotice, setWeekNotice] = React.useState(null);
        const noticeTimers = React.useRef([]);

        const flash = React.useCallback((setter, tone, text) => {
          setter({ tone: tone, text: text });
          const timer = window.setTimeout(() => {
            setter((current) => (current !== null && current.text === text ? null : current));
            const index = noticeTimers.current.indexOf(timer);
            if (index >= 0) noticeTimers.current.splice(index, 1);
          }, 1800);
          noticeTimers.current.push(timer);
        }, []);

        React.useEffect(() => () => {
          for (const timer of noticeTimers.current) window.clearTimeout(timer);
          noticeTimers.current = [];
        }, []);

        // ── 派生显示值 ────────────────────────────────────────────────
        const data = summary.data !== null && typeof summary.data === 'object' ? summary.data : null;
        const summaryPrices = data !== null && typeof data.prices === 'object' && data.prices !== null ? data.prices : {};
        const limit = firstNumber(config.weeklyLimit, data !== null ? data.limit : undefined, DEFAULT_CONFIG.weeklyLimit);
        const prices = {
          input: firstNumber(config.inputPrice, summaryPrices.input, DEFAULT_CONFIG.inputPrice),
          cacheRead: firstNumber(config.cacheReadPrice, summaryPrices.cacheRead, DEFAULT_CONFIG.cacheReadPrice),
          cacheWrite: firstNumber(config.cacheWritePrice, summaryPrices.cacheWrite, DEFAULT_CONFIG.cacheWritePrice),
          output: firstNumber(config.outputPrice, summaryPrices.output, DEFAULT_CONFIG.outputPrice),
        };
        const weekStartsOn = config.weekStartsOn !== undefined
          ? config.weekStartsOn
          : (data !== null && data.weekStartsOn === 'sunday' ? 'sunday' : 'monday');
        const used = firstNumber(data !== null ? data.used : undefined, 0);
        const ratio = limit > 0 ? used / limit : null;
        const percent = data !== null && numberValue(data.percent) !== undefined
          ? data.percent
          : (ratio === null ? 0 : ratio * 100);
        const clampedPercent = Math.max(0, Math.min(100, percent));
        const remaining = data !== null && numberValue(data.remaining) !== undefined ? data.remaining : limit - used;
        const status = data !== null && (data.status === 'ok' || data.status === 'warn' || data.status === 'over')
          ? data.status
          : (ratio === null ? (used > 0 ? 'over' : 'ok') : (ratio >= 1 ? 'over' : (ratio >= 0.8 ? 'warn' : 'ok')));
        const percentLabel = ratio === null && data === null ? '—' : t('dialog.percent', { percent: formatPercentNumber(percent) });
        const tokens = data !== null && typeof data.tokens === 'object' && data.tokens !== null ? data.tokens : {};
        const models = data !== null && Array.isArray(data.models) ? data.models.filter((model) => model !== null && typeof model === 'object') : [];
        const shownModels = models.slice(0, MAX_MODELS);
        const hiddenModels = models.length - shownModels.length;
        const weekStart = pickMillis(data !== null ? data.weekStart : undefined);
        const weekEnd = pickMillis(data !== null ? data.weekEnd : undefined);
        const localWindow = localWeekWindow(weekStartsOn);
        const rangeText = t('dialog.range', {
          start: formatDay(weekStart !== undefined ? weekStart : localWindow.start),
          end: formatDay(weekEnd !== undefined ? weekEnd : localWindow.end),
        });
        const amountText = t('amount.pair', { used: formatAmount(used), limit: formatAmount(limit) });
        const generatedAt = pickMillis(data !== null ? data.generatedAt : undefined);
        const updatedAt = generatedAt !== undefined ? generatedAt : (summary.fetchedAt > 0 ? summary.fetchedAt : undefined);
        const updatedText = updatedAt === undefined ? t('dialog.notUpdated') : t('dialog.updatedAt', { time: formatClock(updatedAt) });
        const ariaLabel = summary.status === 'ready'
          ? t('pill.aria', { used: formatMoney(used), limit: formatMoney(limit), percent: percentLabel })
          : t('pill.ariaLoading', { limit: formatMoney(limit) });
        const readonly = config.writable === false;

        // 打开时把草稿对齐到当前生效值（之后由用户编辑）。
        React.useEffect(() => {
          if (!open) return;
          setLimitDraft(String(limit));
          setPriceDrafts({
            input: String(prices.input),
            cacheRead: String(prices.cacheRead),
            cacheWrite: String(prices.cacheWrite),
            output: String(prices.output),
          });
          setPricesOpen(false);
          // 只在打开瞬间对齐，不跟随轮询覆盖用户输入。
        }, [open]);

        // 打开时顺手读一次，保证「更新于」是打开时刻的。
        React.useEffect(() => {
          if (open) load();
        }, [open, load]);

        /** 保存每周上限。 */
        const saveLimit = () => {
          if (readonly) {
            flash(setLimitNotice, 'error', t('dialog.readonly'));
            return;
          }
          const parsed = Number(String(limitDraft).trim());
          if (!Number.isFinite(parsed) || parsed < 0) {
            flash(setLimitNotice, 'error', t('dialog.invalidNumber'));
            return;
          }
          setBusy(true);
          writeField('weeklyLimit', parsed).then((accepted) => {
            setBusy(false);
            if (accepted) {
              setLimitDraft(String(parsed));
              flash(setLimitNotice, 'ok', t('dialog.saved'));
              load();
              return;
            }
            setLimitDraft(String(limit));
            flash(setLimitNotice, 'error', t('dialog.saveFailed'));
          });
        };

        /**
         * 同步官网定价：按本周用量最大的模型取内置官网快照的峰价写入四个单价，
         * 并打开峰谷计价（官网规定空闲时段价格是高峰价的一半）。
         */
        const syncOfficialPricing = () => {
          if (readonly) {
            flash(setPriceNotice, 'error', t('dialog.readonly'));
            return;
          }
          const dominant = data !== null && Array.isArray(data.models) && data.models.length > 0
            && typeof data.models[0].model === 'string' && data.models[0].model !== ''
            ? data.models[0].model
            : OFFICIAL_PRICING.fallback;
          const known = Object.prototype.hasOwnProperty.call(OFFICIAL_PRICING.models, dominant);
          const appliedModel = known ? dominant : OFFICIAL_PRICING.fallback;
          const table = OFFICIAL_PRICING.models[appliedModel];
          setPriceDrafts({
            input: String(table.input),
            cacheRead: String(table.cacheRead),
            cacheWrite: String(table.cacheWrite),
            output: String(table.output),
          });
          setBusy(true);
          (async () => {
            const writes = [
              ['inputPrice', table.input],
              ['cacheReadPrice', table.cacheRead],
              ['cacheWritePrice', table.cacheWrite],
              ['outputPrice', table.output],
              ['peakPricingEnabled', true],
              ['offPeakRatio', OFFICIAL_PRICING.offPeakRatio],
            ];
            for (let index = 0; index < writes.length; index += 1) {
              const accepted = await writeField(writes[index][0], writes[index][1]);
              if (!accepted) {
                setBusy(false);
                flash(setPriceNotice, 'error', t('dialog.saveFailed'));
                return;
              }
            }
            setBusy(false);
            flash(setPriceNotice, 'ok', t('dialog.syncSynced', { model: appliedModel }));
            load();
          })();
        };

        /** 保存四个单价。 */
        const savePrices = () => {
          if (readonly) {
            flash(setPriceNotice, 'error', t('dialog.readonly'));
            return;
          }
          const parsed = {
            inputPrice: Number(String(priceDrafts.input).trim()),
            cacheReadPrice: Number(String(priceDrafts.cacheRead).trim()),
            cacheWritePrice: Number(String(priceDrafts.cacheWrite).trim()),
            outputPrice: Number(String(priceDrafts.output).trim()),
          };
          for (const key of Object.keys(parsed)) {
            if (!Number.isFinite(parsed[key]) || parsed[key] < 0) {
              flash(setPriceNotice, 'error', t('dialog.invalidNumber'));
              return;
            }
          }
          setBusy(true);
          const fields = Object.keys(parsed);
          const rollback = () => setPriceDrafts({
            input: String(prices.input),
            cacheRead: String(prices.cacheRead),
            cacheWrite: String(prices.cacheWrite),
            output: String(prices.output),
          });
          (async () => {
            for (const key of fields) {
              const accepted = await writeField(key, parsed[key]);
              if (!accepted) {
                setBusy(false);
                rollback();
                flash(setPriceNotice, 'error', t('dialog.saveFailed'));
                return;
              }
            }
            setBusy(false);
            flash(setPriceNotice, 'ok', t('dialog.saved'));
            load();
          })();
        };

        /** 切换每周起始日：立即保存。 */
        const changeWeekStart = (event) => {
          const next = event.target.value === 'sunday' ? 'sunday' : 'monday';
          if (readonly) {
            flash(setWeekNotice, 'error', t('dialog.readonly'));
            return;
          }
          if (next === weekStartsOn) return;
          writeField('weekStartsOn', next).then((accepted) => {
            if (accepted) {
              flash(setWeekNotice, 'ok', t('dialog.saved'));
              load();
              return;
            }
            flash(setWeekNotice, 'error', t('dialog.saveFailed'));
          });
        };

        // disabled 时整颗胶囊不渲染（契约 §4.2 末条）。
        if (!config.enabled) return null;

        const faceNode = h(
          'span',
          { className: 'wb-anchor', ref: anchorRef },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-pill',
              'data-composer-stat': 'weekly-budget',
              'data-state': summary.status === 'ready' ? 'ready' : 'loading',
              'data-status': status,
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              'aria-label': ariaLabel,
              title: ariaLabel,
              onClick: () => setOpen(!open),
            },
            h(
              'span',
              { className: 'wb-row' },
              h('span', { className: 'wb-name' }, t('pill.label')),
              h('span', { className: 'wb-amount' }, amountText),
            ),
            h(
              'span',
              { className: 'wb-bar', 'aria-hidden': true },
              h('span', { className: 'wb-fill', 'data-status': status, style: { width: clampedPercent + '%' } }),
            ),
          ),
          open ? ReactDOM.createPortal(renderDialog(), document.body) : null,
        );
        return faceNode;

        /** 弹窗主体。 */
        function renderDialog() {
          const detailPairs = [
            [t('dialog.remaining'), formatMoney(remaining)],
            [t('dialog.requests'), formatCount(data !== null ? data.requests : undefined)],
            [t('dialog.input'), formatCompactTokens(tokens.input)],
            [t('dialog.cacheRead'), formatCompactTokens(tokens.cacheRead)],
            [t('dialog.output'), formatCompactTokens(tokens.output)],
            [t('dialog.sessions'), formatCount(data !== null ? data.sessions : undefined)],
          ];
          const detailNodes = [];
          for (let index = 0; index < detailPairs.length; index += 1) {
            detailNodes.push(h('dt', { key: 'dt-' + index }, detailPairs[index][0]));
            detailNodes.push(h('dd', { key: 'dd-' + index }, detailPairs[index][1]));
          }
          const modelNodes = [];
          for (let index = 0; index < shownModels.length; index += 1) {
            const model = shownModels[index];
            const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '';
            const name = typeof model.model === 'string' && model.model !== '' ? model.model : '';
            const label = provider !== '' && name !== '' ? provider + '/' + name : (name !== '' ? name : provider);
            modelNodes.push(h(
              'div',
              { className: 'wb-modelRow', key: 'model-' + index },
              h('span', { className: 'wb-modelName', title: label }, label === '' ? '—' : label),
              h('span', { className: 'wb-modelCost' }, formatMoney(model.cost)),
            ));
          }

          const noticeNode = (notice) => (notice === null || notice === undefined
            ? null
            : h('span', { className: 'wb-notice', 'data-tone': notice.tone }, notice.text));

          const priceRow = (key, label) => h(
            'div',
            { className: 'wb-priceRow', key: key },
            h('span', { className: 'wb-priceLabel', title: label }, label),
            h('input', {
              className: 'wb-input',
              type: 'number',
              min: '0',
              step: 'any',
              value: priceDrafts[key],
              disabled: readonly,
              'aria-label': label,
              onChange: (event) => setPriceDrafts((previous) => Object.assign({}, previous, { [key]: event.target.value })),
            }),
          );

          const panelStyle = pos === null
            ? MEASURE_STYLE
            : { left: pos.left + 'px', top: pos.top + 'px' };

          return h(
            'div',
            {
              ref: panelRef,
              className: 'wb-panel',
              role: 'dialog',
              'aria-label': t('dialog.title'),
              'data-state': summary.status,
              style: panelStyle,
            },
            h(
              'div',
              { className: 'wb-head' },
              h(
                'span',
                { className: 'wb-titleMain' },
                h('span', { className: 'wb-whale', 'aria-hidden': true }, '🐋'),
                h('span', { className: 'wb-title' }, t('dialog.title')),
              ),
              h('span', { className: 'wb-headValue' }, amountText),
            ),
            h('div', { className: 'wb-range' }, rangeText),
            h(
              'div',
              { className: 'wb-progressRow' },
              h(
                'div',
                {
                  className: 'wb-progressTrack',
                  role: 'progressbar',
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': Math.round(clampedPercent),
                  'aria-label': percentLabel,
                },
                h('div', { className: 'wb-progressFill', 'data-status': status, style: { width: clampedPercent + '%' } }),
              ),
              h('span', { className: 'wb-percent' }, percentLabel),
            ),
            h('dl', { className: 'wb-details' }, detailNodes),
            summary.status === 'error'
              ? h('div', { className: 'wb-error' }, t('dialog.error', { message: summary.error === null ? '' : summary.error }))
              : null,
            summary.status === 'missing' ? h('div', { className: 'wb-note' }, t('dialog.noSummary')) : null,
            (summary.data === null && (summary.status === 'waiting' || summary.status === 'idle' || summary.status === 'loading'))
              ? h('div', { className: 'wb-note' }, t('dialog.waiting'))
              : null,
            summary.status === 'no-session' ? h('div', { className: 'wb-note' }, t('dialog.noSession')) : null,
            h(
              'div',
              { className: 'wb-field' },
              h('span', { className: 'wb-label' }, t('dialog.limit')),
              h('input', {
                className: 'wb-input',
                type: 'number',
                min: '0',
                step: '1',
                value: limitDraft,
                disabled: readonly,
                'aria-label': t('dialog.limit'),
                onChange: (event) => setLimitDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    saveLimit();
                  }
                },
              }),
              h(
                'button',
                { type: 'button', className: 'wb-button wb-buttonPrimary', disabled: readonly || busy, onClick: saveLimit },
                t('dialog.save'),
              ),
              noticeNode(limitNotice),
            ),
            h(
              'div',
              { className: 'wb-field' },
              h('span', { className: 'wb-label' }, t('dialog.weekStart')),
              h(
                'select',
                {
                  className: 'wb-select',
                  value: weekStartsOn,
                  disabled: readonly,
                  'aria-label': t('dialog.weekStart'),
                  onChange: changeWeekStart,
                },
                h('option', { value: 'monday' }, t('dialog.monday')),
                h('option', { value: 'sunday' }, t('dialog.sunday')),
              ),
              noticeNode(weekNotice),
            ),
            h(
              'div',
              { className: 'wb-fold' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wb-foldHead',
                  'aria-expanded': pricesOpen,
                  onClick: () => setPricesOpen(!pricesOpen),
                },
                h('span', null, t('dialog.prices')),
                h('span', { className: 'wb-chevron', 'data-open': pricesOpen ? 'true' : undefined, 'aria-hidden': true }, '▸'),
              ),
              pricesOpen
                ? h(
                  'div',
                  { className: 'wb-priceGrid' },
                  priceRow('input', t('dialog.priceInput')),
                  priceRow('cacheRead', t('dialog.priceCacheRead')),
                  priceRow('cacheWrite', t('dialog.priceCacheWrite')),
                  priceRow('output', t('dialog.priceOutput')),
                  h(
                    'div',
                    { className: 'wb-priceRow' },
                    h('span', { className: 'wb-priceLabel', 'aria-hidden': true }, ''),
                    h(
                      'button',
                      { type: 'button', className: 'wb-button', disabled: readonly || busy, onClick: savePrices },
                      t('dialog.save'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'wb-priceRow' },
                    h('span', { className: 'wb-priceLabel', 'aria-hidden': true }, ''),
                    h(
                      'button',
                      { type: 'button', className: 'wb-button wb-buttonPrimary', disabled: readonly || busy, onClick: syncOfficialPricing },
                      t('dialog.syncPricing'),
                    ),
                    noticeNode(priceNotice),
                  ),
                  h('div', { className: 'wb-priceHint' }, t('dialog.syncHint')),
                  h('div', { className: 'wb-priceSource' }, t('dialog.syncSource', { source: OFFICIAL_PRICING.source, date: OFFICIAL_PRICING.updated })),
                )
                : null,
            ),
            models.length > 0
              ? h(
                'div',
                { className: 'wb-models' },
                h('div', { className: 'wb-modelsTitle' }, t('dialog.models')),
                modelNodes,
                hiddenModels > 0 ? h('div', { className: 'wb-more' }, t('dialog.moreModels', { count: hiddenModels })) : null,
              )
              : null,
            h('div', { className: 'wb-estimate' }, t('dialog.estimate')),
            h(
              'div',
              { className: 'wb-footer' },
              h('span', { className: 'wb-updated' }, updatedText),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wb-button',
                  disabled: summary.data === null && summary.status === 'loading',
                  onClick: () => load(),
                },
                t('dialog.refresh'),
              ),
            ),
          );
        }
      }

      ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register(
        { name: DOCK_SLOT, id: 'weekly-budget', order: 2, locale: LOCALE_NS },
        WeeklyBudgetPill,
      ));
    }

    return { inject: inject, apply: apply };
  },
});
