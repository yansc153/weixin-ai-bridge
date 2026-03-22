/**
 * Agent backend: Anthropic Claude API (raw fetch, no SDK dependency).
 */

import type { AgentBackend, ImageAttachment } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

type TextMessage = { role: "user" | "assistant"; content: string };
type AnyMessage = TextMessage | { role: "user"; content: unknown[] };

const FETCH_TIMEOUT_MS = 120_000; // 120s
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES_BEFORE_COMPRESS = 20;

function compressHistory(history: AnyMessage[]): AnyMessage[] {
  if (history.length <= MAX_MESSAGES_BEFORE_COMPRESS) return history;
  const early = history.slice(0, 5);
  const recent = history.slice(-10);
  const summary: TextMessage = { role: "assistant", content: "[earlier conversation summarized]" };
  return [...early, summary, ...recent];
}

export class AnthropicAgent implements AgentBackend {
  name: string;
  private apiKey: string;
  private apiBase: string;
  private model: string;
  private systemPrompt: string;
  private conversations = new Map<string, AnyMessage[]>();
  private lastActivity = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(opts: { apiKey: string; model: string; apiBase: string; systemPrompt?: string }) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt || "你是一个有用的 AI 助手。回答简洁。";
    this.name = `Anthropic (${this.model})`;

    // Periodic cleanup of idle conversations
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, ts] of this.lastActivity) {
        if (now - ts > IDLE_TIMEOUT_MS) {
          this.conversations.delete(userId);
          this.lastActivity.delete(userId);
          console.log(`[anthropic] 清理闲置会话: ${userId}`);
        }
      }
    }, CLEANUP_INTERVAL_MS).unref();
  }

  async ask(userId: string, message: string): Promise<string> {
    if (!this.apiKey) return "⚠️ 未设置 API Key。用 --api-key 或 ANTHROPIC_API_KEY 环境变量配置。";

    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [];
      this.conversations.set(userId, history);
    }
    history.push({ role: "user", content: message });

    // Auto-compress conversation history
    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[anthropic] 调用 ${this.model} (${history.length} msgs)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: this.systemPrompt,
          messages: history,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err}`);
      }

      const data = await res.json() as {
        content: { type: string; text: string }[];
      };
      const reply = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      history.push({ role: "assistant", content: reply });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[anthropic] 完成 (${elapsed}s, ${reply.length} chars)`);
      return reply || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[anthropic] 错误:`, msg);
      return `⚠️ Anthropic 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  async askStream(userId: string, message: string, onChunk: (text: string, done: boolean) => void): Promise<string> {
    if (!this.apiKey) return "⚠️ 未设置 API Key。用 --api-key 或 ANTHROPIC_API_KEY 环境变量配置。";

    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [];
      this.conversations.set(userId, history);
    }
    history.push({ role: "user", content: message });

    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[anthropic] 流式调用 ${this.model} (${history.length} msgs)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: this.systemPrompt,
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

        let currentEvent = "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);

          try {
            const parsed = JSON.parse(payload);
            if (currentEvent === "content_block_delta" && parsed.delta?.text) {
              accumulated += parsed.delta.text;
              onChunk(accumulated, false);
            } else if (currentEvent === "message_stop") {
              onChunk(accumulated, true);
            }
          } catch { /* skip malformed lines */ }
          currentEvent = "";
        }
      }

      // Ensure done is signalled
      if (accumulated) {
        onChunk(accumulated, true);
      }

      history.push({ role: "assistant", content: accumulated });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[anthropic] 流式完成 (${elapsed}s, ${accumulated.length} chars)`);
      return accumulated || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[anthropic] 流式错误:`, msg);
      return `⚠️ Anthropic 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  async askWithImages(
    userId: string,
    message: string,
    images: ImageAttachment[],
    onChunk?: (text: string, done: boolean) => void,
  ): Promise<string> {
    if (!this.apiKey) return "⚠️ 未设置 API Key。用 --api-key 或 ANTHROPIC_API_KEY 环境变量配置。";

    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [];
      this.conversations.set(userId, history);
    }

    // Build multimodal content: images first, then text
    const content: unknown[] = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data.toString("base64") },
    }));
    if (message) content.push({ type: "text", text: message });

    // Store text summary in history (not the base64 blobs)
    const historyText = `[用户发送了${images.length}张图片]${message ? " " + message : ""}`;
    history.push({ role: "user", content });

    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[anthropic] 视觉调用 ${this.model} (${images.length}图)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: this.systemPrompt,
          messages: history,
          stream: !!onChunk,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err}`);
      }

      let reply: string;

      if (onChunk) {
        let accumulated = "";
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let currentEvent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("event: ")) { currentEvent = trimmed.slice(7); continue; }
            if (!trimmed.startsWith("data: ")) continue;
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              if (currentEvent === "content_block_delta" && parsed.delta?.text) {
                accumulated += parsed.delta.text;
                onChunk(accumulated, false);
              } else if (currentEvent === "message_stop") {
                onChunk(accumulated, true);
              }
            } catch { /* skip */ }
            currentEvent = "";
          }
        }
        if (accumulated) onChunk(accumulated, true);
        reply = accumulated;
      } else {
        const data = await res.json() as { content: { type: string; text: string }[] };
        reply = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      }

      // Replace the multimodal history entry with text summary for future turns
      let idx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === "user" && Array.isArray((history[i] as { content: unknown }).content)) { idx = i; break; }
      }
      if (idx >= 0) (history[idx] as TextMessage) = { role: "user", content: historyText };
      history.push({ role: "assistant", content: reply });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[anthropic] 视觉完成 (${elapsed}s, ${reply.length} chars)`);
      return reply || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[anthropic] 视觉错误:`, msg);
      return `⚠️ Anthropic 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  reset(userId: string): void {
    this.conversations.delete(userId);
    this.lastActivity.delete(userId);
  }
}
