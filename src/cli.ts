#!/usr/bin/env node
/**
 * weixin-ai-bridge — 一条命令，让微信连上 AI
 *
 * Usage:
 *   npx weixin-ai-bridge                # 首次自动进入交互式配置
 *   npx weixin-ai-bridge --setup        # 重新配置
 *   npx weixin-ai-bridge --login        # 重新扫码登录微信
 *   npx weixin-ai-bridge --agent openai --api-key sk-xxx  # 直接指定参数
 */

import { parseArgs } from "node:util";
import { loginWithQR, loadAccount } from "./auth.js";
import { startMonitor } from "./monitor.js";
import { createAgent, type AgentConfig } from "./agents/types.js";
import { runSetup, loadConfig, configExists } from "./setup.js";
import { ensureDeps } from "./deps.js";
import type { ApiConfig } from "./weixin-api.js";

const HELP = `
weixin-ai-bridge — 一条命令，让微信连上 AI

用法:
  npx weixin-ai-bridge [选项]

选项:
  --setup                 运行交互式配置向导
  --agent <name>          AI 后端: claude-code | openai | anthropic | ollama | command
  --model <model>         模型名 (用于 openai/anthropic/ollama)
  --api-key <key>         API 密钥 (优先级高于环境变量)
  --api-base <url>        自定义 API 地址 (兼容 OpenAI 格式的任何 API)
  --command <cmd>         自定义命令 (用于 --agent command)
  --system-prompt <text>  系统提示词
  --login                 重新扫码登录微信
  --help                  显示帮助

首次运行自动进入配置向导。配置保存在 ~/.weixin-ai-bridge/config.json

示例:
  npx weixin-ai-bridge                                          # 交互式配置
  npx weixin-ai-bridge --agent openai --api-key sk-xxx          # GPT-4o
  npx weixin-ai-bridge --agent openai --api-base https://api.deepseek.com --model deepseek-chat
  npx weixin-ai-bridge --agent anthropic                        # Claude API
  npx weixin-ai-bridge --agent ollama --model qwen2             # 本地 Ollama
`.trim();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      setup:          { type: "boolean", default: false },
      agent:          { type: "string" },
      model:          { type: "string" },
      "api-key":      { type: "string" },
      "api-base":     { type: "string" },
      command:        { type: "string" },
      "system-prompt": { type: "string" },
      login:          { type: "boolean", default: false },
      help:           { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log("╔═══════════════════════════════════════╗");
  console.log("║     weixin-ai-bridge                  ║");
  console.log("║     一条命令，让微信连上 AI            ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log();

  // Check and install optional dependencies (ffmpeg, whisper, etc.)
  await ensureDeps();

  // Resolve agent config: CLI flags > saved config > interactive setup
  let agentConfig: AgentConfig;

  const hasCLIAgent = values.agent || values["api-key"] || values["api-base"] || values.model;

  if (hasCLIAgent) {
    // CLI flags provided — use them directly
    agentConfig = {
      agent: (values.agent || "openai") as AgentConfig["agent"],
      model: values.model,
      apiKey: values["api-key"],
      apiBase: values["api-base"],
      command: values.command,
      systemPrompt: values["system-prompt"],
    };
  } else if (values.setup || !configExists()) {
    // No config or --setup: run interactive wizard
    agentConfig = await runSetup();
    console.log();
  } else {
    // Use saved config
    const saved = loadConfig();
    if (!saved) {
      agentConfig = await runSetup();
      console.log();
    } else {
      agentConfig = saved;
    }
  }

  // Apply CLI overrides on top of saved config
  if (values["system-prompt"]) agentConfig.systemPrompt = values["system-prompt"];

  const agent = await createAgent(agentConfig);
  console.log(`AI 后端: ${agent.name}`);
  console.log();

  // WeChat login
  let account = loadAccount();

  if (!account || values.login) {
    console.log(values.login ? "重新登录微信..." : "需要扫码登录微信。");
    account = await loginWithQR();
  } else {
    console.log(`微信已登录 (${account.accountId})`);
    console.log();
  }

  const apiCfg: ApiConfig = {
    baseUrl: account.baseUrl,
    token: account.token,
  };

  // Start monitor
  const ac = new AbortController();
  const shutdown = () => {
    console.log("\n正在停止...");
    ac.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("开始监听微信消息... (Ctrl+C 停止)\n");

  try {
    await startMonitor(apiCfg, agent, ac.signal);
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error("致命错误:", err);
      process.exit(1);
    }
  }

  console.log("已退出。");
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
