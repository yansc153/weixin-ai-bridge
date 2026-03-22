<div align="center">

<img src="https://img.shields.io/badge/WeChat-iLink%20Bot-07C160?style=for-the-badge&logo=wechat&logoColor=white" />

# weixin-ai-bridge

**一条命令，让微信接入任意 AI**
<br/>
**One command to bridge WeChat with any AI**

[![npm version](https://img.shields.io/npm/v/weixin-ai-bridge?color=cb3837&label=npm&logo=npm&style=flat-square)](https://www.npmjs.com/package/weixin-ai-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](https://github.com/yansc153/weixin-ai-bridge/pulls)
[![GitHub Stars](https://img.shields.io/github/stars/yansc153/weixin-ai-bridge?style=flat-square&logo=github)](https://github.com/yansc153/weixin-ai-bridge/stargazers)

</div>

---

## 简介 · Overview

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/yansc153/weixin-ai-bridge/install.sh | bash
```

**一条命令，让微信接入任意 AI。** 内置交互式配置向导，无需额外开发。

**One command to bridge WeChat with any AI.** Built-in setup wizard, no extra coding needed.

---

## 特性 · Features

| 功能 | 描述 |
|------|------|
| 🤖 **多 AI 后端** | Claude Code CLI · Gemini CLI · Codex CLI · OpenAI API · Anthropic API · Ollama |
| 🖼️ **图片理解** | 发送图片，AI 直接分析内容（视觉模型） |
| 🎙️ **语音识别** | 微信内置 ASR + 本地 Whisper 双重兜底 |
| 🎬 **视频分析** | ffmpeg 抽帧 + Whisper 音频转录，全面理解视频内容 |
| 📄 **文件解析** | PDF · Word · Excel · PPT · EPUB · 代码文件全支持 |
| ⚡ **流式输出** | AI 回复实时打字机效果推送到微信 |
| 🔄 **多轮对话** | 每位用户独立会话，自动压缩历史，支持 `/reset` 清除 |
| 🛠️ **自动安装依赖** | 启动时自动检测并安装 ffmpeg · whisper · pdftotext · pandoc · xlsx2csv |
| 🔒 **零硬编码** | 所有密钥通过 Setup Wizard 交互配置，本地存储 |

---

## AI 后端支持 · Supported AI Backends

| 后端 | 类型 | 流式 | 图片 | 备注 |
|------|------|:----:|:----:|------|
| **Claude Code** | 本地 CLI | ✅ | ✅ | 推荐，无需 API Key |
| **Gemini CLI** | 本地 CLI | ✅ | ✅ | Google Gemini |
| **Codex CLI** | 本地 CLI | ✅ | ❌ | OpenAI Codex |
| **Anthropic API** | 云端 API | ✅ | ✅ | 直连 Claude API |
| **OpenAI API** | 云端 API | ✅ | ✅ | 兼容所有 OpenAI 格式 API |
| **Ollama** | 本地模型 | ✅ | ❌ | Llama · Qwen 等本地模型 |

> OpenAI 兼容 API 可接入：DeepSeek · Moonshot · 零一万物 · 阶跃星辰等任意服务

---

## 媒体支持 · Media Support

| 类型 | 支持方式 |
|------|---------|
| 📝 **文本** | 直接对话 |
| 🖼️ **图片** | 发送图片 → AI 视觉分析 |
| 🎙️ **语音** | 微信 ASR 转文字 → Whisper 本地兜底 |
| 🎬 **视频** | ffmpeg 抽关键帧 + Whisper 音频转录 |
| 📄 **PDF** | pdftotext 提取正文 |
| 📝 **Word** `.docx` `.odt` `.rtf` | pandoc 转纯文本 |
| 📊 **Excel** `.xlsx` `.xls` | xlsx2csv 转 CSV |
| 📊 **PowerPoint** `.pptx` | pandoc 提取文字 |
| 📖 **EPUB** | pandoc 提取正文 |
| 💻 **代码文件** `.ts` `.py` `.go` 等 | 直接读取，含语法高亮 |

---

## 安装 · Install

### macOS / Linux（国内推荐 · China-friendly）

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/yansc153/weixin-ai-bridge/install.sh | bash
```

> 自动完成：Xcode CLT · Homebrew（国内镜像）· Node.js · npm 镜像 · pip 镜像

### Windows（PowerShell 管理员 · Run as Administrator）

```powershell
irm https://cdn.jsdelivr.net/gh/yansc153/weixin-ai-bridge/install.ps1 | iex
```

> 自动完成：winget · Node.js · Python · ffmpeg · pandoc · poppler · npm 镜像 · pip 镜像

---

## 快速开始 · Quick Start

### 前置要求

- Node.js ≥ 20
- 微信 iLink Bot 账号（[申请地址](https://ilink.qq.com)）
- 至少一个 AI 后端（Claude Code CLI 推荐）

### 直接运行

```bash
# 直接运行（推荐）
npx weixin-ai-bridge

# 或全局安装
npm install -g weixin-ai-bridge
weixin-ai-bridge
```

### 首次配置

首次运行会自动进入 **Setup Wizard**，引导你完成全部配置：

```
  weixin-ai-bridge Setup Wizard
  作者：花椒

✓ Detected claude CLI at /usr/local/bin/claude
✓ Detected gemini CLI at /usr/local/bin/gemini

? Select AI backend:
  1) Claude Code  (Anthropic, local CLI)
  2) Gemini CLI   (Google, local CLI)
  3) OpenAI-Compatible API
  4) Anthropic API
  5) Ollama (local)
> Choose [1-5]:
```

配置完成后扫码登录微信，即可开始使用。

---

## 命令行参数 · CLI Options

```
Usage: npx weixin-ai-bridge [options]

Options:
  --setup                 重新运行配置向导
  --agent <name>          指定 AI 后端: claude-code | gemini | codex | openai | anthropic | ollama
  --model <model>         指定模型名称
  --api-key <key>         API 密钥（优先级高于环境变量）
  --api-base <url>        自定义 API 地址（兼容 OpenAI 格式）
  --system-prompt <text>  自定义系统提示词
  --login                 重新扫码登录微信
  --help                  显示帮助
```

### 快捷示例

```bash
# Claude Code（本地，无需 Key）
npx weixin-ai-bridge --agent claude-code

# OpenAI GPT-4o
npx weixin-ai-bridge --agent openai --api-key sk-xxx

# DeepSeek（兼容 OpenAI 格式）
npx weixin-ai-bridge --agent openai \
  --api-base https://api.deepseek.com \
  --model deepseek-chat \
  --api-key sk-xxx

# 本地 Ollama
npx weixin-ai-bridge --agent ollama --model qwen2

# Gemini CLI
npx weixin-ai-bridge --agent gemini
```

---

## 微信内置命令 · In-Chat Commands

| 命令 | 效果 |
|------|------|
| `/reset` 或 `/清除` | 清空当前对话历史 |
| `/help` 或 `/帮助` | 显示帮助信息 |

---

## 架构 · Architecture

```
微信用户
   │  发送消息 (文字/图片/语音/视频/文件)
   ▼
WeChat iLink Bot API
   │  长轮询获取消息
   ▼
weixin-ai-bridge (monitor.ts)
   │
   ├─ 文字消息 ──────────────────► AgentBackend.askStream()
   ├─ 图片/视频 ─► CDN 下载解密 ──► AgentBackend.askWithImages()
   ├─ 语音 ──────► ASR / Whisper ──► AgentBackend.askStream()
   └─ 文件 ──────► 文本提取 ────────► AgentBackend.askStream()
                    (PDF/DOCX/XLSX/PPTX/EPUB/代码)
   │
   ▼
AI 后端 (claude-code / gemini / openai / anthropic / ollama)
   │
   ▼
流式回复推送 → 微信 (打字机效果)
```

---

## 依赖自动安装 · Auto Dependencies

启动时自动检测并安装以下工具（需要 brew / apt / pip3）：

| 工具 | 用途 | 安装方式 |
|------|------|---------|
| `ffmpeg` | 视频抽帧 + 音频提取 | `brew install ffmpeg` |
| `whisper` | 本地语音/视频转录 | `pip3 install openai-whisper` |
| `pdftotext` | PDF 文本提取 | `brew install poppler` |
| `pandoc` | Word/PPT/EPUB 提取 | `brew install pandoc` |
| `xlsx2csv` | Excel 文本提取 | `pip3 install xlsx2csv` |

---

## Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=yansc153/weixin-ai-bridge&type=Date)](https://star-history.com/#yansc153/weixin-ai-bridge&Date)

</div>

---

## 贡献 · Contributing

欢迎 PR 和 Issue！

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 提交：`git commit -m 'feat: add something'`
4. 推送：`git push origin feat/your-feature`
5. 提交 Pull Request

---

## 许可证 · License

[MIT](LICENSE) © 花椒

---

<div align="center">

**作者：花椒**

如果这个项目对你有帮助，欢迎点个 ⭐ Star！

*Made with ❤️ for WeChat + AI enthusiasts*

</div>
