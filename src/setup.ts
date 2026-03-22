/**
 * Interactive CLI setup wizard for weixin-ai-bridge.
 * Uses only Node.js built-ins — no external dependencies.
 */
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentConfig } from "./agents/types.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  red: "\x1b[31m", magenta: "\x1b[35m",
};
const info = (msg: string) => console.log(`${c.cyan}i${c.reset} ${msg}`);
const ok   = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`);
const warn = (msg: string) => console.log(`${c.yellow}!${c.reset} ${msg}`);
const fail = (msg: string) => console.log(`${c.red}✗${c.reset} ${msg}`);

const CONFIG_DIR  = path.join(os.homedir(), ".weixin-ai-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): AgentConfig | null {
  if (!configExists()) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AgentConfig;
  } catch {
    return null;
  }
}

function saveConfig(config: AgentConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* non-POSIX platforms */ }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function whichSync(cmd: string): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execSync(`${finder} ${cmd}`, { encoding: "utf-8" }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function createRL(): readline.Interface {
  // When invoked via `curl | bash`, stdin is a pipe (not a TTY) and gives
  // immediate EOF — reopen from /dev/tty so the wizard can read keystrokes.
  let input: NodeJS.ReadableStream = process.stdin;
  if (!process.stdin.isTTY) {
    try { input = fs.createReadStream("/dev/tty"); } catch { /* Windows or no tty */ }
  }
  const rl = readline.createInterface({ input, output: process.stdout });
  rl.on("close", () => { console.log(`\n${c.dim}Setup cancelled.${c.reset}`); process.exit(0); });
  return rl;
}

function ask(rl: readline.Interface, question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` ${c.dim}(${fallback})${c.reset}` : "";
  return new Promise((resolve) => {
    rl.question(`${c.bold}?${c.reset} ${question}${suffix}: `, (a) => resolve(a.trim() || fallback));
  });
}

function askSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${c.bold}?${c.reset} ${question}: `);
    const raw = process.stdin;
    const wasRaw = raw.isRaw;
    if (raw.setRawMode) raw.setRawMode(true);
    let secret = "";
    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf-8");
      if (ch === "\n" || ch === "\r") {
        if (raw.setRawMode) raw.setRawMode(wasRaw ?? false);
        raw.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(secret);
      } else if (ch === "\u0003") {
        if (raw.setRawMode) raw.setRawMode(wasRaw ?? false);
        raw.removeListener("data", onData);
        console.log(`\n${c.dim}Setup cancelled.${c.reset}`);
        process.exit(0);
      } else if (ch === "\u007F" || ch === "\b") {
        if (secret.length > 0) { secret = secret.slice(0, -1); process.stdout.write("\b \b"); }
      } else {
        secret += ch;
        process.stdout.write("*");
      }
    };
    raw.on("data", onData);
  });
}

function choose(rl: readline.Interface, question: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n${c.bold}?${c.reset} ${question}`);
    options.forEach((opt, i) => console.log(`  ${c.cyan}${i + 1}${c.reset}) ${opt}`));
    const tryAsk = () => {
      rl.question(`${c.bold}>${c.reset} Choose [1-${options.length}]: `, (ans) => {
        const n = parseInt(ans, 10);
        if (n >= 1 && n <= options.length) resolve(n - 1);
        else { warn("Invalid choice, try again."); tryAsk(); }
      });
    };
    tryAsk();
  });
}

async function fetchJSON(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchModels(
  agent: AgentConfig["agent"], apiBase: string, apiKey?: string,
): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const data = (await fetchJSON(`${apiBase}/v1/models`, headers)) as {
      data?: { id: string }[];
    };
    return (data.data ?? []).map((m) => m.id);
  } catch { return []; }
}

async function testConnection(config: AgentConfig): Promise<boolean> {
  try {
    if (config.agent === "claude-code") {
      execSync("claude --version", { encoding: "utf-8", timeout: 5000 });
      return true;
    }
    if (config.agent === "codex") {
      execSync("codex --version", { encoding: "utf-8", timeout: 5000 });
      return true;
    }
    if (config.agent === "gemini") {
      execSync("gemini --version", { encoding: "utf-8", timeout: 5000 });
      return true;
    }
    const base = config.apiBase?.replace(/\/+$/, "");
    const body = JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: "Say hi in one word." }],
      max_tokens: 16,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers, body, signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch { return false; }
}

async function verifyLocalCLI(
  rl: readline.Interface,
  binary: string,
  installCmd: string,
  envKeyName?: string,
): Promise<void> {
  info(`Verifying ${binary} CLI...`);
  try {
    const ver = execSync(`${binary} --version`, { encoding: "utf-8", timeout: 5000 }).trim();
    ok(`${binary} ${ver}`);
  } catch {
    fail(`Could not run '${binary} --version'. Install with: ${installCmd}`);
    rl.close(); process.exit(1);
  }
  if (envKeyName) {
    const envVal = process.env[envKeyName];
    if (!envVal) {
      warn(`${envKeyName} is not set in environment.`);
      const key = await askSecret(rl, `${binary} API key`);
      if (key) {
        process.env[envKeyName] = key;
        ok(`Key saved for this session: ${c.dim}${maskKey(key)}${c.reset}`);
        warn(`Add ${envKeyName} to your shell profile to persist across restarts.`);
      }
    } else {
      ok(`${envKeyName} detected: ${c.dim}${maskKey(envVal)}${c.reset}`);
    }
  }
}

// ── Main wizard ──────────────────────────────────────────────────────────────

export async function runSetup(): Promise<AgentConfig> {
  console.log(`\n${c.magenta}${c.bold}  weixin-ai-bridge Setup Wizard${c.reset}`);
  console.log(`  ${c.dim}作者：花椒${c.reset}\n`);
  const rl = createRL();

  // Detect local CLI tools
  const hasClaude = whichSync("claude");
  const hasCodex  = whichSync("codex");
  const hasGemini = whichSync("gemini");
  if (hasClaude) ok(`Detected claude CLI at ${c.dim}${hasClaude}${c.reset}`);
  if (hasCodex)  ok(`Detected codex CLI at ${c.dim}${hasCodex}${c.reset}`);
  if (hasGemini) ok(`Detected gemini CLI at ${c.dim}${hasGemini}${c.reset}`);

  // Build backend choices
  const opts: { label: string; value: AgentConfig["agent"] }[] = [];
  if (hasClaude) opts.push({ label: "Claude Code  (Anthropic, local CLI)", value: "claude-code" });
  if (hasCodex)  opts.push({ label: "Codex CLI    (OpenAI, local CLI)", value: "codex" });
  if (hasGemini) opts.push({ label: "Gemini CLI   (Google, local CLI)", value: "gemini" });
  opts.push(
    { label: "OpenAI 兼容 API  (DeepSeek · Moonshot · 通义 · 智谱 · GPT 等)", value: "openai" },
    { label: "Anthropic API  (Claude，需翻墙或代理)", value: "anthropic" },
  );

  const idx = await choose(rl, "Select AI backend:", opts.map((o) => o.label));
  const config: AgentConfig = { agent: opts[idx].value };

  if (config.agent === "claude-code") {
    await verifyLocalCLI(rl, "claude", "npm i -g @anthropic-ai/claude-code");
  }

  if (config.agent === "codex") {
    await verifyLocalCLI(rl, "codex", "npm i -g @openai/codex", "OPENAI_API_KEY");
  }

  if (config.agent === "gemini") {
    await verifyLocalCLI(rl, "gemini", "npm i -g @google/gemini-cli", "GEMINI_API_KEY");
  }

  // ── API-based backends
  if (config.agent === "openai" || config.agent === "anthropic") {
    let defaultModel: string;

    if (config.agent === "openai") {
      // Chinese provider sub-menu
      const providers = [
        { label: "DeepSeek              api.deepseek.com               (推荐，性价比极高)", base: "https://api.deepseek.com",                                     model: "deepseek-chat" },
        { label: "Moonshot 月之暗面      api.moonshot.cn",               base: "https://api.moonshot.cn",                                        model: "moonshot-v1-8k" },
        { label: "通义千问 (Qwen)        dashscope.aliyuncs.com",        base: "https://dashscope.aliyuncs.com/compatible-mode/v1",             model: "qwen-turbo" },
        { label: "智谱 GLM              open.bigmodel.cn",              base: "https://open.bigmodel.cn/api/paas",                              model: "glm-4-flash" },
        { label: "OpenAI 官方           api.openai.com                 (需翻墙)", base: "https://api.openai.com",                               model: "gpt-4o" },
        { label: "自定义 API 地址...",   base: "",                                                                                               model: "gpt-4o" },
      ];
      const pi = await choose(rl, "选择服务商 (Select provider):", providers.map((p) => p.label));
      const chosen = providers[pi];
      if (chosen.base) {
        config.apiBase = chosen.base;
        ok(`API 地址: ${c.dim}${config.apiBase}${c.reset}`);
      } else {
        config.apiBase = (await ask(rl, "API base URL", "https://api.openai.com")).replace(/\/+$/, "");
      }
      defaultModel = chosen.model;
    } else {
      config.apiBase = "https://api.anthropic.com";
      defaultModel = "claude-sonnet-4-6-20250514";
    }

    config.apiKey = await askSecret(rl, "API key");
    if (config.apiKey) ok(`Key saved: ${c.dim}${maskKey(config.apiKey)}${c.reset}`);
    else warn("No API key provided — requests may fail.");

    info("Fetching available models...");
    const models = await fetchModels(config.agent, config.apiBase, config.apiKey);

    if (models.length > 0) {
      ok(`Found ${models.length} model(s).`);
      const display = models.slice(0, 20);
      const mi = await choose(rl, "Select a model:", [...display, "Enter manually..."]);
      config.model = mi < display.length ? display[mi] : await ask(rl, "Model name", defaultModel);
    } else {
      warn("Could not fetch model list — enter model name manually.");
      config.model = await ask(rl, "Model name", defaultModel);
    }

    info("Testing connection...");
    if (await testConnection(config)) ok("Connection successful!");
    else warn("Connection test failed. Config saved anyway — re-run setup later.");
  }

  // ── Optional system prompt
  const customPrompt = await ask(rl, "Custom system prompt? (leave empty to skip)");
  if (customPrompt) config.systemPrompt = customPrompt;

  // ── Save
  saveConfig(config);
  ok(`Config saved to ${c.dim}${CONFIG_PATH}${c.reset}`);
  console.log(`\n${c.green}${c.bold}  Setup complete!${c.reset}\n`);
  rl.close();
  return config;
}
