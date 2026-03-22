/**
 * Dependency checker + auto-installer for optional media processing tools.
 * Runs at startup: detects missing tools and installs them silently.
 */

import { execSync, execFileSync } from "node:child_process";

const c = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

// ── Detection helpers ─────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }).trim();
  } catch { return null; }
}

function hasBrew(): boolean { return !!which("brew"); }
function hasPip3(): boolean { return !!which("pip3") || !!which("pip"); }
function pip3(): string { return which("pip3") ? "pip3" : "pip"; }

// ── Installers ────────────────────────────────────────────────────────────────

type InstallResult = "ok" | "failed" | "skipped";

function brewInstall(pkg: string): InstallResult {
  if (!hasBrew()) return "skipped";
  try {
    execSync(`brew install ${pkg}`, { stdio: "inherit" });
    return "ok";
  } catch { return "failed"; }
}

function aptInstall(pkg: string): InstallResult {
  if (!which("apt-get")) return "skipped";
  try {
    execSync(`apt-get install -y ${pkg}`, { stdio: "inherit" });
    return "ok";
  } catch {
    try {
      execSync(`sudo apt-get install -y ${pkg}`, { stdio: "inherit" });
      return "ok";
    } catch { return "failed"; }
  }
}

function pipInstall(pkg: string): InstallResult {
  if (!hasPip3()) return "skipped";
  try {
    execSync(`${pip3()} install ${pkg}`, { stdio: "inherit" });
    return "ok";
  } catch { return "failed"; }
}

function installForPlatform(
  macPkg: string,
  linuxPkg: string,
  pipPkg?: string,
): InstallResult {
  if (process.platform === "darwin") {
    const r = brewInstall(macPkg);
    if (r !== "skipped") return r;
    if (pipPkg) return pipInstall(pipPkg);
    return "skipped";
  }
  if (process.platform === "linux") {
    const r = aptInstall(linuxPkg);
    if (r !== "skipped") return r;
    if (pipPkg) return pipInstall(pipPkg);
    return "skipped";
  }
  if (pipPkg) return pipInstall(pipPkg);
  return "skipped";
}

// ── Dependency definitions ────────────────────────────────────────────────────

interface Dep {
  name: string;
  check(): boolean;
  install(): InstallResult;
  purpose: string;
}

const DEPS: Dep[] = [
  {
    name: "ffmpeg",
    purpose: "视频抽帧 + 音频提取",
    check: () => !!which("ffmpeg"),
    install: () => installForPlatform("ffmpeg", "ffmpeg"),
  },
  {
    name: "whisper",
    purpose: "本地语音/视频转录",
    check: () => !!which("whisper"),
    install: () => {
      // Try brew cask first (macOS), then pip
      if (process.platform === "darwin" && hasBrew()) {
        const r = brewInstall("openai-whisper");
        if (r === "ok") return "ok";
      }
      return pipInstall("openai-whisper");
    },
  },
  {
    name: "pdftotext",
    purpose: "PDF 文本提取",
    check: () => !!which("pdftotext"),
    install: () => installForPlatform("poppler", "poppler-utils"),
  },
  {
    name: "pandoc",
    purpose: "Word/PPT/EPUB 文本提取",
    check: () => !!which("pandoc"),
    install: () => installForPlatform("pandoc", "pandoc"),
  },
  {
    name: "xlsx2csv",
    purpose: "Excel 文本提取",
    check: () => !!which("xlsx2csv"),
    install: () => pipInstall("xlsx2csv"),
  },
];

// ── Main export ───────────────────────────────────────────────────────────────

export interface DepsStatus {
  ffmpeg: boolean;
  whisper: boolean;
  pdftotext: boolean;
  pandoc: boolean;
  xlsx2csv: boolean;
}

/**
 * Check all optional dependencies and install any that are missing.
 * Called once at startup. Never throws — missing deps just disable features.
 */
export async function ensureDeps(): Promise<DepsStatus> {
  const missing = DEPS.filter((d) => !d.check());

  if (missing.length === 0) {
    const installed = DEPS.map((d) => `${c.green}✓${c.reset} ${d.name}`).join("  ");
    console.log(`依赖: ${installed}`);
    console.log();
    return buildStatus();
  }

  // Show what's present and what needs installing
  for (const dep of DEPS) {
    const ok = dep.check();
    console.log(
      `${ok ? `${c.green}✓` : `${c.yellow}⬇`}${c.reset} ${dep.name.padEnd(10)} ${c.dim}${dep.purpose}${c.reset}`,
    );
  }

  console.log();
  console.log(`正在安装缺少的依赖 (${missing.map((d) => d.name).join(", ")})...`);
  console.log();

  for (const dep of missing) {
    process.stdout.write(`  安装 ${dep.name}... `);
    const result = dep.install();
    if (result === "ok") {
      console.log(`${c.green}完成${c.reset}`);
    } else if (result === "failed") {
      console.log(`${c.red}失败${c.reset} — 跳过，相关功能不可用`);
    } else {
      // skipped: platform not supported
      console.log(
        `${c.yellow}跳过${c.reset} — 请手动安装: ${installHint(dep.name)}`,
      );
    }
  }

  console.log();
  return buildStatus();
}

function buildStatus(): DepsStatus {
  return {
    ffmpeg: !!which("ffmpeg"),
    whisper: !!which("whisper"),
    pdftotext: !!which("pdftotext"),
    pandoc: !!which("pandoc"),
    xlsx2csv: !!which("xlsx2csv"),
  };
}

function installHint(name: string): string {
  if (name === "ffmpeg") return process.platform === "darwin" ? "brew install ffmpeg" : "apt install ffmpeg";
  if (name === "whisper") return "pip3 install openai-whisper";
  if (name === "pdftotext") return process.platform === "darwin" ? "brew install poppler" : "apt install poppler-utils";
  if (name === "pandoc") return process.platform === "darwin" ? "brew install pandoc" : "apt install pandoc";
  if (name === "xlsx2csv") return "pip3 install xlsx2csv";
  return `安装 ${name}`;
}
