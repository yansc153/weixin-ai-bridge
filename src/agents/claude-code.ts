/**
 * Agent backend: Claude Code CLI (--print mode).
 * Requires `claude` CLI installed globally.
 */

import { execFile, spawn } from "node:child_process";
import type { AgentBackend, ImageAttachment } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

const userSessions = new Map<string, string>();
const lastActivity = new Map<string, number>();

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
  const now = Date.now();
  for (const [userId, ts] of lastActivity) {
    if (now - ts > IDLE_TIMEOUT_MS) {
      userSessions.delete(userId);
      lastActivity.delete(userId);
      console.log(`[claude-code] 清理闲置会话: ${userId}`);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

export class ClaudeCodeAgent implements AgentBackend {
  name = "Claude Code";

  async ask(userId: string, message: string): Promise<string> {
    return this._ask(userId, message, false);
  }

  private async _ask(userId: string, message: string, isRetry: boolean): Promise<string> {
    lastActivity.set(userId, Date.now());
    const sessionId = userSessions.get(userId);

    const args = [
      "-p", message,
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "30",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const bin = process.env.CLAUDE_BIN || "claude";
      console.log(`[claude-code] 调用${sessionId ? ` (resume=${sessionId.slice(0, 8)}...)` : " (新会话)"}`);

      execFile(bin, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
        env: { ...process.env },
      }, (error, stdout) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (error) {
          console.error(`[claude-code] 错误 (${elapsed}s):`, error.message);
          // If session resume failed and this is NOT already a retry, try once without session
          if (sessionId && !isRetry) {
            userSessions.delete(userId);
            resolve(this._ask(userId, message, true));
            return;
          }
          resolve(`⚠️ Claude Code 出错: ${sanitizeErrorMessage(error.message)}`);
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.session_id) {
            userSessions.set(userId, result.session_id);
          }
          const text = result.result ?? "";
          console.log(`[claude-code] 完成 (${elapsed}s, ${text.length} chars)`);
          resolve(text || "[Claude Code 处理完成，无文本输出]");
        } catch {
          const text = stdout.trim();
          console.log(`[claude-code] 完成 (${elapsed}s, ${text.length} chars)`);
          resolve(text || "[Claude Code 无输出]");
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
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "30",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const bin = process.env.CLAUDE_BIN || "claude";
      console.log(`[claude-code] 流式调用${sessionId ? ` (resume=${sessionId.slice(0, 8)}...)` : " (新会话)"}`);

      const child = spawn(bin, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let accumulated = "";
      let newSessionId: string | undefined;
      let buffer = "";
      let doneSent = false;

      const timeout = setTimeout(() => {
        child.kill();
        resolve(`⚠️ Claude Code 超时`);
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

            // Capture session_id from any message
            if (parsed.session_id) {
              newSessionId = parsed.session_id;
            }

            // Handle assistant text messages
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

            if (parsed.type === "result") {
              if (parsed.result) {
                accumulated = parsed.result;
              }
              if (parsed.session_id) {
                newSessionId = parsed.session_id;
              }
              if (!doneSent) { doneSent = true; onChunk(accumulated, true); }
            }
          } catch { /* skip malformed lines */ }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[claude-code] stderr: ${msg}`);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Flush any incomplete last line in the buffer
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim());
            if (parsed.session_id) newSessionId = parsed.session_id;
            if (parsed.type === "result" && parsed.result) accumulated = parsed.result;
          } catch { /* incomplete line, ignore */ }
        }

        if (code !== 0 && !accumulated) {
          console.error(`[claude-code] 流式退出 code=${code} (${elapsed}s)`);
          if (sessionId && !isRetry) {
            userSessions.delete(userId);
            resolve(this._askStream(userId, message, onChunk, true));
            return;
          }
          resolve(`⚠️ Claude Code 出错 (exit ${code})`);
          return;
        }

        if (newSessionId) {
          userSessions.set(userId, newSessionId);
        }

        if (accumulated && !doneSent) {
          doneSent = true;
          onChunk(accumulated, true);
        }

        console.log(`[claude-code] 流式完成 (${elapsed}s, ${accumulated.length} chars)`);
        resolve(accumulated || "[Claude Code 处理完成，无文本输出]");
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        console.error(`[claude-code] spawn 错误:`, err.message);
        resolve(`⚠️ Claude Code 出错: ${sanitizeErrorMessage(err.message)}`);
      });
    });
  }

  async askWithImages(
    userId: string,
    message: string,
    images: ImageAttachment[],
    onChunk?: (text: string, done: boolean) => void,
  ): Promise<string> {
    return this._askWithImages(userId, message, images, onChunk ?? (() => {}), false);
  }

  private async _askWithImages(
    userId: string,
    message: string,
    images: ImageAttachment[],
    onChunk: (text: string, done: boolean) => void,
    isRetry: boolean,
  ): Promise<string> {
    lastActivity.set(userId, Date.now());
    const sessionId = userSessions.get(userId);

    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "30",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    // Build multimodal message
    const content: unknown[] = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data.toString("base64") },
    }));
    if (message) content.push({ type: "text", text: message });

    const inputMsg = JSON.stringify({ type: "user", message: { role: "user", content } });

    return new Promise((resolve) => {
      const startTime = Date.now();
      const bin = process.env.CLAUDE_BIN || "claude";
      console.log(`[claude-code] 视觉调用${sessionId ? ` (resume=${sessionId.slice(0, 8)}...)` : " (新会话)"} (${images.length}图)`);

      const child = spawn(bin, args, {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin.write(inputMsg + "\n");
      child.stdin.end();

      let accumulated = "";
      let newSessionId: string | undefined;
      let buffer = "";
      let doneSent = false;

      const timeout = setTimeout(() => {
        child.kill();
        resolve("⚠️ Claude Code 超时");
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
            if (parsed.session_id) newSessionId = parsed.session_id;
            if (parsed.type === "assistant" && parsed.message?.content) {
              let text = "";
              for (const block of parsed.message.content) {
                if (block.type === "text" && block.text) text += block.text;
              }
              if (text) { accumulated = text; onChunk(accumulated, false); }
            }
            if (parsed.type === "result") {
              if (parsed.result) accumulated = parsed.result;
              if (parsed.session_id) newSessionId = parsed.session_id;
              if (!doneSent) { doneSent = true; onChunk(accumulated, true); }
            }
          } catch { /* skip malformed */ }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[claude-code] stderr: ${msg}`);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim());
            if (parsed.session_id) newSessionId = parsed.session_id;
            if (parsed.type === "result" && parsed.result) accumulated = parsed.result;
          } catch { /* incomplete line */ }
        }

        if (code !== 0 && !accumulated) {
          console.error(`[claude-code] 视觉退出 code=${code} (${elapsed}s)`);
          if (sessionId && !isRetry) {
            userSessions.delete(userId);
            resolve(this._askWithImages(userId, message, images, onChunk, true));
            return;
          }
          resolve(`⚠️ Claude Code 出错 (exit ${code})`);
          return;
        }

        if (newSessionId) userSessions.set(userId, newSessionId);
        if (accumulated && !doneSent) { doneSent = true; onChunk(accumulated, true); }

        console.log(`[claude-code] 视觉完成 (${elapsed}s, ${accumulated.length} chars)`);
        resolve(accumulated || "[Claude Code 处理完成，无文本输出]");
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        console.error(`[claude-code] spawn 错误:`, err.message);
        resolve(`⚠️ Claude Code 出错: ${sanitizeErrorMessage(err.message)}`);
      });
    });
  }

  reset(userId: string): void {
    userSessions.delete(userId);
    lastActivity.delete(userId);
  }
}
