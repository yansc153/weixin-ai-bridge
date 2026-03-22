/**
 * Agent backend: Ollama (local LLM, raw fetch).
 */

import type { AgentBackend } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

type Message = { role: "system" | "user" | "assistant"; content: string };

const FETCH_TIMEOUT_MS = 120_000; // 120s
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES_BEFORE_COMPRESS = 20;

function compressHistory(history: Message[]): Message[] {
  if (history.length <= MAX_MESSAGES_BEFORE_COMPRESS) return history;
  // Keep system prompt (first), first 5 user/assistant msgs, summary, last 10
  const system = history[0];
  const early = history.slice(1, 6);
  const recent = history.slice(-10);
  const summary: Message = {
    role: "assistant",
    content: "[earlier conversation summarized]",
  };
  return [system, ...early, summary, ...recent];
}

export class OllamaAgent implements AgentBackend {
  name: string;
  private apiBase: string;
  private model: string;
  private systemPrompt: string;
  private conversations = new Map<string, Message[]>();
  private lastActivity = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(opts: { model: string; apiBase: string; systemPrompt?: string }) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt || "你是一个有用的 AI 助手。回答简洁。";
    this.name = `Ollama (${this.model})`;

    // Periodic cleanup of idle conversations
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, ts] of this.lastActivity) {
        if (now - ts > IDLE_TIMEOUT_MS) {
          this.conversations.delete(userId);
          this.lastActivity.delete(userId);
          console.log(`[ollama] 清理闲置会话: ${userId}`);
        }
      }
    }, CLEANUP_INTERVAL_MS).unref();
  }

  async ask(userId: string, message: string): Promise<string> {
    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [{ role: "system", content: this.systemPrompt }];
      this.conversations.set(userId, history);
    }
    history.push({ role: "user", content: message });

    // Auto-compress conversation history
    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[ollama] 调用 ${this.model} (${history.length} msgs)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: history,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err}`);
      }

      const data = await res.json() as {
        message: { content: string };
      };
      const reply = data.message?.content ?? "";
      history.push({ role: "assistant", content: reply });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[ollama] 完成 (${elapsed}s, ${reply.length} chars)`);
      return reply || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ollama] 错误:`, msg);
      return `⚠️ Ollama 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  async askStream(userId: string, message: string, onChunk: (text: string, done: boolean) => void): Promise<string> {
    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [{ role: "system", content: this.systemPrompt }];
      this.conversations.set(userId, history);
    }
    history.push({ role: "user", content: message });

    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[ollama] 流式调用 ${this.model} (${history.length} msgs)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: history,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err}`);
      }

      let accumulated = "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as {
              message?: { content?: string };
              done?: boolean;
            };
            if (parsed.message?.content) {
              accumulated += parsed.message.content;
              onChunk(accumulated, !!parsed.done);
            }
            if (parsed.done) {
              onChunk(accumulated, true);
            }
          } catch { /* skip malformed lines */ }
        }
      }

      // Ensure done is signalled
      if (accumulated) {
        onChunk(accumulated, true);
      }

      history.push({ role: "assistant", content: accumulated });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[ollama] 流式完成 (${elapsed}s, ${accumulated.length} chars)`);
      return accumulated || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ollama] 流式错误:`, msg);
      return `⚠️ Ollama 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  reset(userId: string): void {
    this.conversations.delete(userId);
    this.lastActivity.delete(userId);
  }
}
