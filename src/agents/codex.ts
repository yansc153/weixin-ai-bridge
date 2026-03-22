/**
 * Agent backend: Codex CLI (OpenAI coding agent).
 * Requires `codex` CLI installed globally (npm i -g @openai/codex).
 * Uses `codex exec --full-auto -o <file>` for non-interactive operation.
 */

import { execFile } from "node:child_process";
import { unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentBackend } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

export class CodexAgent implements AgentBackend {
  name = "Codex CLI";

  async ask(userId: string, message: string): Promise<string> {
    const outFile = join(tmpdir(), `codex-${userId}-${randomUUID()}.txt`);

    return new Promise((resolve) => {
      const startTime = Date.now();
      const bin = process.env.CODEX_BIN || "codex";
      console.log(`[codex] 调用`);

      execFile(bin, ["exec", message, "--full-auto", "-o", outFile], {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
        env: { ...process.env },
      }, (error) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (error) {
          console.error(`[codex] 错误 (${elapsed}s):`, error.message);
        }

        let text = "";
        try {
          text = readFileSync(outFile, "utf-8").trim();
        } catch { /* file may not exist on error */ } finally {
          try { unlinkSync(outFile); } catch { /* ignore */ }
        }

        if (error) {
          resolve(text || `⚠️ Codex 出错: ${sanitizeErrorMessage(error.message)}`);
          return;
        }

        console.log(`[codex] 完成 (${elapsed}s, ${text.length} chars)`);
        resolve(text || "[Codex 处理完成，无文本输出]");
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reset(_userId: string): void {
    // Codex sessions are managed locally by the CLI; no in-process state to clear
  }
}
