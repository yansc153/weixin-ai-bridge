/**
 * Agent backend: Codex CLI.
 * Requires `codex` CLI installed globally.
 */

import { exec, execFile } from "node:child_process";
import { unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentBackend } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

export class CodexAgent implements AgentBackend {
  name = "Codex CLI";
  private bin = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.cmd" : "codex");

  private quoteWinArg(arg: string): string {
    return `"${arg.replace(/"/g, '""')}"`;
  }

  async ask(userId: string, message: string): Promise<string> {
    const outFile = join(tmpdir(), `codex-${userId}-${randomUUID()}.txt`);
    const args = ["exec", message, "--full-auto", "-o", outFile];

    return new Promise((resolve) => {
      const startTime = Date.now();
      console.log("[codex] call");

      const finish = (error: Error | null) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (error) {
          console.error(`[codex] error (${elapsed}s):`, error.message);
        }

        let text = "";
        try {
          text = readFileSync(outFile, "utf-8").trim();
        } catch {
          // file may not exist on error
        } finally {
          try { unlinkSync(outFile); } catch { /* ignore */ }
        }

        if (error) {
          resolve(text || `⚠️ Codex 出错: ${sanitizeErrorMessage(error.message)}`);
          return;
        }

        console.log(`[codex] done (${elapsed}s, ${text.length} chars)`);
        resolve(text || "[Codex completed with no text output]");
      };

      if (process.platform === "win32") {
        const cmdline = [this.quoteWinArg(this.bin), ...args.map((arg) => this.quoteWinArg(arg))].join(" ");
        exec(cmdline, {
          shell: "cmd.exe",
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
          env: { ...process.env },
        }, (error) => finish(error));
        return;
      }

      execFile(this.bin, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
        env: { ...process.env },
      }, (error) => finish(error));
    });
  }

  reset(_userId: string): void {
    // Codex sessions are managed locally by the CLI; no in-process state to clear.
  }
}
