#!/usr/bin/env node
/**
 * 提交前隐私检查。
 *
 * 扫描 git 跟踪的所有文件，拦截以下内容：
 *   - 本机用户目录路径（C:\Users\<具体用户名>）
 *   - 个人 Desktop 路径（例如 D:\Desktop\...）
 *   - 任何盘符绝对路径（例如 D:\DeepSeek Harness\...）：对外文档必须写成占位符
 *   - 运行本脚本的机器的 Windows 用户名（运行时从 os.userInfo() 读取，不在本文件里硬编码）
 *   - GitHub / 云厂商凭据（PAT、sk-、AKIA）
 *   - 私钥
 *   - 邮箱地址（example.com / users.noreply.github.com / git@github.com 除外）
 *
 * 命中时不回显具体内容，只报告文件名与行号，避免检查过程本身泄露。
 *
 * 用法：node tools/check-privacy.mjs
 * 退出码：0 通过，1 有命中。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const user = os.userInfo().username
const SELF = 'tools/check-privacy.mjs'

/** 转义正则元字符。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 规则表：出问题时只报告规则名，不回显匹配到的内容。
 * allow 用于放行占位符与公开地址。
 */
const RULES = [
  {
    name: '本机用户目录路径',
    pattern: /[A-Za-z]:[\\/]Users[\\/](?!<|%|~)[A-Za-z0-9._-]+/g,
  },
  {
    name: '个人 Desktop 路径',
    pattern: /[A-Za-z]:[\\/]Desktop[\\/]/g,
  },
  {
    name: '本机 Windows 用户名',
    pattern: user.length >= 3 ? new RegExp('(?<![A-Za-z0-9_])' + escapeRegExp(user) + '(?![A-Za-z0-9_])', 'g') : null,
  },
  {
    // 盘符绝对路径（本机安装目录、D:\xxx 之类）：对外文档里必须写成占位符。
    // 占位符 <...>、%VAR%、$env:VAR 以及 URL 不算。
    name: '本机绝对路径',
    pattern: /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!<|%|\$)[^\s"'`]*/g,
    allow: (match) => /[<%$]/.test(match),
  },
  {
    name: '凭据 token',
    pattern: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/g,
  },
  {
    name: '私钥',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: '邮箱地址',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allow: (match) => /@example\.(com|org)$|@users\.noreply\.github\.com$|^git@github\.com$/i.test(match),
  },
]

/** 只检查文本文件与常见脚本/配置扩展名。 */
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.txt', '.sh', '.ps1', '.svg', '.html', '.css', '.gitignore', '.gitattributes'])

function isTextCandidate(file) {
  const base = path.basename(file)
  if (base === '.gitignore' || base === '.gitattributes') return true
  return TEXT_EXT.has(path.extname(file).toLowerCase())
}

let files
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
} catch (error) {
  console.error('[check-privacy] 无法读取 git 文件列表：', error.message)
  process.exit(2)
}

const hits = []
for (const file of files) {
  if (file === SELF) continue
  if (!isTextCandidate(file)) continue
  const absolute = path.join(root, file)
  let text
  try {
    text = fs.readFileSync(absolute, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of RULES) {
      if (rule.pattern === null) continue
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(lines[index])) !== null) {
        if (rule.allow !== undefined && rule.allow(match[0])) continue
        hits.push({ file, line: index + 1, rule: rule.name })
        break
      }
    }
  }
}

if (hits.length === 0) {
  console.log('[check-privacy] 通过：' + files.length + ' 个跟踪文件里没有发现本机路径、用户名、凭据或邮箱。')
  process.exit(0)
}
console.error('[check-privacy] 发现 ' + hits.length + ' 处疑似隐私内容（未回显具体内容）：')
for (const hit of hits) console.error('  - ' + hit.file + ':' + hit.line + '  「' + hit.rule + '」')
console.error('\n处理建议：改成占位符（如 <你的插件目录>、<profile>、%USERPROFILE%），或从文件里移除。')
process.exit(1)
