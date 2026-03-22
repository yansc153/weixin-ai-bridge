/**
 * Long-poll message monitor: receives WeChat messages and dispatches to AI agent.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getUpdates,
  sendMessage,
  sendMessageStreaming,
  sendTyping,
  getConfig,
  extractTextBody,
  detectMediaTypes,
  MessageItemType,
  type ApiConfig,
  type GetUpdatesResp,
  type WeixinMessage,
} from "./weixin-api.js";
import { DATA_DIR } from "./auth.js";
import type { AgentBackend, ImageAttachment } from "./agents/types.js";
import { downloadMediaItem, extractDocumentText, extractVideoContent, transcribeVoiceData } from "./cdn.js";

const SYNC_BUF_FILE = path.join(DATA_DIR, "sync-buf.txt");
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const MAX_CHUNK_LEN = 4000;
const STREAM_THROTTLE_MS = 800;
const SESSION_EXPIRY_CODE = -14;
const SESSION_EXPIRY_INITIAL_WAIT_MS = 60_000;

const contextTokens = new Map<string, string>();

function loadSyncBuf(): string {
  try {
    if (fs.existsSync(SYNC_BUF_FILE)) {
      return fs.readFileSync(SYNC_BUF_FILE, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return "";
}

function saveSyncBuf(buf: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SYNC_BUF_FILE, buf, "utf-8");
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_CHUNK_LEN);
    if (splitAt < MAX_CHUNK_LEN / 2) splitAt = MAX_CHUNK_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/^#{1,6}\s+/gm, "");
  return result;
}

async function processMessage(
  cfg: ApiConfig,
  agent: AgentBackend,
  msg: WeixinMessage,
): Promise<void> {
  const userId = msg.from_user_id ?? "";
  const contextToken = msg.context_token ?? "";
  if (!userId) return;

  if (contextToken) contextTokens.set(userId, contextToken);
  const ct = contextTokens.get(userId);
  if (!ct) {
    console.log(`[monitor] 无 contextToken, 跳过 from=${userId}`);
    return;
  }

  const textBody = extractTextBody(msg);
  const media = detectMediaTypes(msg);

  // Download images, files, and video
  const downloadedImages: ImageAttachment[] = [];
  let effectiveText = textBody;

  // Download voice only as fallback when WeChat didn't provide a transcription
  const needsVoiceDownload = media.hasVoice && !textBody;

  if (media.hasImage || media.hasFile || media.hasVideo || needsVoiceDownload) {
    const mediaItems = (msg.item_list ?? []).filter(
      (item) => item.type === MessageItemType.IMAGE ||
        item.type === MessageItemType.FILE ||
        item.type === MessageItemType.VIDEO ||
        (item.type === MessageItemType.VOICE && needsVoiceDownload),
    );
    const downloadResults = await Promise.all(mediaItems.map((item) => downloadMediaItem(item)));
    for (const downloaded of downloadResults) {
      if (!downloaded) continue;
      if (downloaded.type === "image") {
        downloadedImages.push({ mimeType: downloaded.mimeType, data: downloaded.data });
        console.log(`[monitor] 图片已下载 ${downloaded.data.length} bytes`);
      } else if (downloaded.type === "file") {
        const fname = downloaded.fileName ?? "unknown";
        const text = await extractDocumentText(downloaded.data, fname);
        if (text) {
          effectiveText = (effectiveText ? effectiveText + "\n\n" : "")
            + `[文件: ${fname}]\n\`\`\`\n${text}\n\`\`\``;
          console.log(`[monitor] 文件已提取文本 ${text.length} chars (${fname})`);
        } else {
          await sendMessage(cfg, userId, `📎 收到文件 "${fname}"，格式暂不支持内容提取`, ct).catch(() => {});
        }
      } else if (downloaded.type === "voice") {
        console.log(`[monitor] 语音已下载 ${downloaded.data.length} bytes，正在转录...`);
        const transcript = await transcribeVoiceData(downloaded.data);
        if (transcript) {
          effectiveText = transcript;
          console.log(`[monitor] 语音转录完成 (${transcript.length} chars)`);
        }
      } else if (downloaded.type === "video") {
        console.log(`[monitor] 视频已下载 ${(downloaded.data.length / 1024 / 1024).toFixed(1)} MB，提取帧...`);
        await sendMessage(cfg, userId, "🎬 收到视频，正在分析...", ct).catch(() => {});
        const analysis = await extractVideoContent(downloaded.data);
        if (analysis) {
          for (const frame of analysis.frames) downloadedImages.push(frame);
          const hint = [`[视频分析，时长约 ${analysis.durationSec?.toFixed(0) ?? "?"} 秒，提取了 ${analysis.frames.length} 帧]`];
          if (analysis.transcript) hint.push(`[音频转录]: ${analysis.transcript}`);
          if (effectiveText) hint.push(effectiveText);
          effectiveText = hint.join("\n");
          console.log(`[monitor] 视频提取完成: ${analysis.frames.length} 帧${analysis.transcript ? " + 转录" : ""}`);
        } else {
          await sendMessage(cfg, userId, "📎 视频处理失败，请发截图或描述问题", ct).catch(() => {});
        }
      }
    }
  }

  // Nothing processable
  if (!effectiveText && downloadedImages.length === 0) {
    if (media.hasImage) {
      await sendMessage(cfg, userId, "📎 图片下载失败，请稍后重试或用文字描述问题", ct).catch(() => {});
    } else if (media.hasFile) {
      await sendMessage(cfg, userId, "📎 文件下载失败，请稍后重试", ct).catch(() => {});
    } else if (media.hasVideo) {
      await sendMessage(cfg, userId, "📎 视频处理失败，请发截图或描述问题", ct).catch(() => {});
    } else if (media.hasVoice) {
      await sendMessage(cfg, userId, "🎤 收到语音，未能识别内容，请手动输入文字", ct).catch(() => {});
    } else {
      await sendMessage(cfg, userId, "📎 暂不支持该消息类型，请发送文字", ct).catch(() => {});
    }
    return;
  }

  const previewText = effectiveText || `[${downloadedImages.length}张图片]`;
  console.log(`[monitor] 收到消息 from=${userId}: ${previewText.slice(0, 80)}${previewText.length > 80 ? "..." : ""}`);

  // Handle special commands
  if (textBody === "/reset" || textBody === "/清除") {
    agent.reset(userId);
    await sendMessage(cfg, userId, "✅ 对话已重置", ct);
    return;
  }

  if (textBody === "/help" || textBody === "/帮助") {
    await sendMessage(cfg, userId, [
      `🤖 微信 × ${agent.name}`,
      "",
      `直接发消息即可与 ${agent.name} 对话。`,
      "",
      "命令:",
      "/reset 或 /清除 — 重置对话",
      "/help 或 /帮助 — 显示帮助",
    ].join("\n"), ct);
    return;
  }

  // Send typing indicator
  let typingTicket: string | undefined;
  try {
    const config = await getConfig(cfg, userId, ct);
    typingTicket = config.typing_ticket;
    if (typingTicket) {
      await sendTyping(cfg, userId, typingTicket, 1);
    }
  } catch { /* best-effort */ }

  try {
    if (downloadedImages.length > 0 && agent.askWithImages) {
      // Vision path: agent supports images
      await processMessageWithImages(cfg, agent, userId, effectiveText || "", downloadedImages, ct, typingTicket);
    } else if (downloadedImages.length > 0) {
      // Images downloaded but agent doesn't support vision
      await sendMessage(cfg, userId, "📎 当前 AI 不支持图片分析，请用文字描述问题", ct).catch(() => {});
      if (!effectiveText) return;
      // If there's also text, fall through to text-only processing
      if (agent.askStream) {
        await processMessageStreaming(cfg, agent, userId, effectiveText, ct, typingTicket);
      } else {
        const response = await agent.ask(userId, effectiveText);
        const cleaned = stripMarkdown(response);
        for (const chunk of chunkText(cleaned)) {
          await sendMessage(cfg, userId, chunk, contextTokens.get(userId) ?? ct);
        }
        console.log(`[monitor] 已回复 to=${userId} (${cleaned.length} chars)`);
      }
    } else if (agent.askStream) {
      await processMessageStreaming(cfg, agent, userId, effectiveText!, ct, typingTicket);
    } else {
      // Fallback: non-streaming path
      const response = await agent.ask(userId, effectiveText!);
      const cleaned = stripMarkdown(response);
      const chunks = chunkText(cleaned);
      for (const chunk of chunks) {
        const latestCt = contextTokens.get(userId) ?? ct;
        await sendMessage(cfg, userId, chunk, latestCt);
      }
      console.log(`[monitor] 已回复 to=${userId} (${cleaned.length} chars)`);
    }
  } finally {
    if (typingTicket) {
      try { await sendTyping(cfg, userId, typingTicket, 2); } catch { /* best-effort */ }
    }
  }
}

async function runStreamingReply(
  cfg: ApiConfig,
  userId: string,
  ct: string,
  typingTicket: string | undefined,
  invoke: (onChunk: (text: string, done: boolean) => void) => Promise<string>,
  label: string,
): Promise<void> {
  const clientId = crypto.randomUUID();
  let lastSendTime = 0;
  let lastSentText = "";
  let pendingSend: ReturnType<typeof setTimeout> | null = null;
  let latestText = "";

  const sendUpdate = async (text: string, done: boolean) => {
    const cleaned = stripMarkdown(text);
    if (cleaned === lastSentText && !done) return;
    const latestCt = contextTokens.get(userId) ?? ct;
    try {
      await sendMessageStreaming(cfg, userId, cleaned, latestCt, clientId, done);
      lastSentText = cleaned;
      lastSendTime = Date.now();
    } catch (err) {
      console.error(`[monitor] ${label}发送出错:`, err);
    }
    if (!done && typingTicket) {
      try { await sendTyping(cfg, userId, typingTicket, 1); } catch { /* best-effort */ }
    }
  };

  const onChunk = (text: string, done: boolean) => {
    latestText = text;
    if (done) {
      if (pendingSend) { clearTimeout(pendingSend); pendingSend = null; }
      return;
    }
    const elapsed = Date.now() - lastSendTime;
    if (elapsed >= STREAM_THROTTLE_MS) {
      if (pendingSend) { clearTimeout(pendingSend); pendingSend = null; }
      sendUpdate(text, false).catch(() => {});
    } else if (!pendingSend) {
      pendingSend = setTimeout(() => {
        pendingSend = null;
        sendUpdate(latestText, false).catch(() => {});
      }, STREAM_THROTTLE_MS - elapsed);
    }
  };

  const response = await invoke(onChunk);

  if (pendingSend) { clearTimeout(pendingSend); pendingSend = null; }

  const finalText = stripMarkdown(response || latestText);
  if (finalText) {
    const latestCt = contextTokens.get(userId) ?? ct;
    await sendMessageStreaming(cfg, userId, finalText, latestCt, clientId, true);
  }

  console.log(`[monitor] ${label}完成 to=${userId} (${finalText.length} chars)`);
}

async function processMessageWithImages(
  cfg: ApiConfig,
  agent: AgentBackend,
  userId: string,
  message: string,
  images: ImageAttachment[],
  ct: string,
  typingTicket: string | undefined,
): Promise<void> {
  console.log(`[monitor] 开始视觉回复 to=${userId} (${images.length}图)`);
  await runStreamingReply(cfg, userId, ct, typingTicket,
    (onChunk) => agent.askWithImages!(userId, message, images, onChunk),
    "视觉回复",
  );
}

async function processMessageStreaming(
  cfg: ApiConfig,
  agent: AgentBackend,
  userId: string,
  textBody: string,
  ct: string,
  typingTicket: string | undefined,
): Promise<void> {
  console.log(`[monitor] 开始流式回复 to=${userId}`);
  await runStreamingReply(cfg, userId, ct, typingTicket,
    (onChunk) => agent.askStream!(userId, textBody, onChunk),
    "流式回复",
  );
}

export async function startMonitor(
  cfg: ApiConfig,
  agent: AgentBackend,
  abortSignal?: AbortSignal,
): Promise<void> {
  console.log(`[monitor] 微信消息监听已启动 (agent: ${agent.name})`);
  console.log(`[monitor] API: ${cfg.baseUrl}`);

  let getUpdatesBuf = loadSyncBuf();
  let nextTimeoutMs = 35_000;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp: GetUpdatesResp = await getUpdates(cfg, getUpdatesBuf, nextTimeoutMs);

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isError = (resp.ret !== undefined && resp.ret !== 0) ||
                      (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        // Detect WeChat session expiry (error code -14)
        if (resp.errcode === SESSION_EXPIRY_CODE || resp.ret === SESSION_EXPIRY_CODE) {
          console.error(`[monitor] ⚠️ 微信会话已过期 (code=${SESSION_EXPIRY_CODE})，需要重新登录!`);
          console.error(`[monitor] 请重新运行 weixin-ai-bridge 进行二维码扫码登录。`);
          console.error(`[monitor] 暂停所有 API 调用，等待重试...`);
          let sessionRetryWait = SESSION_EXPIRY_INITIAL_WAIT_MS;
          const maxSessionRetryWait = 10 * 60_000; // max 10 minutes
          while (!abortSignal?.aborted) {
            await sleep(sessionRetryWait, abortSignal);
            if (abortSignal?.aborted) break;
            console.log(`[monitor] 尝试重新连接微信...`);
            try {
              const retryResp = await getUpdates(cfg, getUpdatesBuf, 5000);
              const retryIsExpired = retryResp.errcode === SESSION_EXPIRY_CODE || retryResp.ret === SESSION_EXPIRY_CODE;
              if (!retryIsExpired) {
                console.log(`[monitor] 微信会话已恢复!`);
                if (retryResp.get_updates_buf) {
                  saveSyncBuf(retryResp.get_updates_buf);
                  getUpdatesBuf = retryResp.get_updates_buf;
                }
                break;
              }
            } catch { /* retry again */ }
            sessionRetryWait = Math.min(sessionRetryWait * 2, maxSessionRetryWait);
            console.error(`[monitor] 微信仍未恢复，${Math.round(sessionRetryWait / 1000)}s 后重试...`);
          }
          consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures++;
        console.error(`[monitor] getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[monitor] 连续失败 ${MAX_CONSECUTIVE_FAILURES} 次, 等待 30s...`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        saveSyncBuf(resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        try {
          await processMessage(cfg, agent, msg);
        } catch (err) {
          console.error(`[monitor] 处理消息出错:`, err);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) break;
      consecutiveFailures++;
      console.error(`[monitor] 轮询出错 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  console.log("[monitor] 监听已停止");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
