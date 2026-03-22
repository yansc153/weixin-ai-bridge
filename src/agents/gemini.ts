/**
 * Agent backend: Gemini CLI (--output-format json/stream-json mode).
 * Requires `gemini` CLI installed globally (npm i -g @google/gemini-cli).
 */

import { execFile, spawn } from "node:child_process";
import type { AgentBackend } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

const userSessions = new Map<string, string>();
const lastActivity = new Map<string, number>();

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes

setInterval(() => {
  const now = Date.now();
  for (const [userId, ts] of lastActivity) {
    if (now - ts > IDLE_TIMEOUT_MS) {
      userSessions.delete(userId);
      lastActivity.delete(userId);
      console.log(`[gemini] 清理闲置会话: ${userId}`);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

export class GeminiAgent implements AgentBackend {
  name = "Gemini CLI";

  async ask(userId: string, message: string): Promise<string> {
    return this._ask(userId, message, false);
  }

  private async _ask(userId: string, message: string, isRetry: boolean): Promise<string> {
    lastActivity.set(userId, Date.now());
    const sessionId = userSessions.get(userId);

    const args = [
      "-p", message,
      "--output-format", "json",
      "--approval-mode", "yolo",
    ];

    if (sessionId) {
      args.push("-r", sessionId);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const bin = process.env.GEMINI_BIN || "gemini";
      console.log(`[gemini] 调用${sessionId ? ` (resume=${sessionId.slice(0, 8)}...)` : " (新会话)"}`);

      execFile(bin, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
        env: { ...process.env },
      }, (error, stdout) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (error) {
          console.error(`[gemini] 错误 (${elapsed}s):`, error.message);
          if (sessionId && !isRetry) {
            userSessions.delete(userId);
            resolve(this._ask(userId, message, true));
            return;
          }
          resolve(`⚠️ Gemini CLI 出错: ${sanitizeErrorMessage(error.message)}`);
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.session_id) {
            userSessions.set(userId, result.session_id);
          }
          const text = result.result ?? result.response ?? result.text ?? "";
          console.log(`[gemini] 完成 (${elapsed}s, ${text.length} chars)`);
          resolve(text || "[Gemini 处理完成，无文本输出]");
        } catch {
          const text = stdout.trim();
          console.log(`[gemini] 完成 (${elapsed}s, ${text.length} chars)`);
          resolve(text || "[Gemini 无输出]");
        }
      });
    });
  }

  async askStream(userId: string, message: string, onChunk: (text: string, done: boolean) => void): Promise<string> {
    return this._askStream(userId, message, onChunk, false);
  }

  private async _askStream(userId: string, message: string, onChunk: (text: string, done: boolean) => void, isRetry: boolean): Promise<string> {
    lastActivity.set(userId, Date.now());
    const sessionId = userSessions.get(userId);

    const args = [
      "-p", message,
      "--output-format", "stream-json",
      "--approval-mode", "yolo",
    ];

    if (sessionId) {
      args.push("-r", sessionId);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const bin = process.env.GEMINI_BIN || "gemini";
      console.log(`[gemini] 流式调用${sessionId ? ` (resume=${sessionId.slice(0, 8)}...)` : " (新会话)"}`);

      const child = spawn(bin, args, {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let accumulated = "";
      let newSessionId: string | undefined;
      let buffer = "";
      let doneSent = false;

      const timeout = setTimeout(() => {
        child.kill();
        resolve(`⚠️ Gemini CLI 超时`);
      }, 5 * 60 * 1000);

      child.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);

            if (parsed.session_id) {
              newSessionId = parsed.session_id;
            }

            if (parsed.type === "assistant" && parsed.message?.content) {
              let text = "";
              for (const block of parsed.message.content) {
                if (block.type === "text" && block.text) {
                  text += block.text;
                }
              }
              if (text) {
                accumulated = text;
                onChunk(accumulated, false);
              }
            }

            if (parsed.type === "content" && parsed.text) {
              accumulated += parsed.text;
              onChunk(accumulated, false);
            }

            if (parsed.type === "result") {
              const text = parsed.result ?? parsed.response ?? parsed.text ?? accumulated;
              if (text) accumulated = text;
              if (parsed.session_id) newSessionId = parsed.session_id;
              if (!doneSent) { doneSent = true; onChunk(accumulated, true); }
            }
          } catch { /* skip malformed lines */ }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[gemini] stderr: ${msg}`);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Flush any incomplete last line in the buffer
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim());
            if (parsed.session_id) newSessionId = parsed.session_id;
            const text = parsed.result ?? parsed.response ?? parsed.text;
            if (text) accumulated = text;
          } catch { /* incomplete line, ignore */ }
        }

        if (code !== 0 && !accumulated) {
          console.error(`[gemini] 流式退出 code=${code} (${elapsed}s)`);
          if (sessionId && !isRetry) {
            userSessions.delete(userId);
            resolve(this._askStream(userId, message, onChunk, true));
            return;
          }
          resolve(`⚠️ Gemini CLI 出错 (exit ${code})`);
          return;
        }

        if (newSessionId) {
          userSessions.set(userId, newSessionId);
        }

        if (accumulated && !doneSent) {
          doneSent = true;
          onChunk(accumulated, true);
        }

        console.log(`[gemini] 流式完成 (${elapsed}s, ${accumulated.length} chars)`);
        resolve(accumulated || "[Gemini 处理完成，无文本输出]");
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        console.error(`[gemini] spawn 错误:`, err.message);
        resolve(`⚠️ Gemini CLI 出错: ${sanitizeErrorMessage(err.message)}`);
      });
    });
  }

  reset(userId: string): void {
    userSessions.delete(userId);
    lastActivity.delete(userId);
  }
}
