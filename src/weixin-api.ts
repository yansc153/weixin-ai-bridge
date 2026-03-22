/**
 * WeChat iLink Bot API — extracted from @tencent-weixin/openclaw-weixin
 * Endpoints: getupdates, sendmessage, sendtyping, getconfig, get_bot_qrcode, get_qrcode_status
 */

import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; aeskey?: string };
  voice_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; text?: string };
  file_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; file_name?: string };
  video_item?: { media?: { encrypt_query_param?: string; aes_key?: string } };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string | undefined, bodyStr: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base).toString();
  const hdrs = buildHeaders(params.token, params.body);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`API ${params.endpoint} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ApiConfig {
  baseUrl: string;
  token: string;
}

/** Long-poll for new messages. */
export async function getUpdates(
  cfg: ApiConfig,
  getUpdatesBuf: string,
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl: cfg.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: getUpdatesBuf, base_info: {} }),
      token: cfg.token,
      timeoutMs,
    });
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/** Send a text message. */
export async function sendMessage(
  cfg: ApiConfig,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl: cfg.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: crypto.randomUUID(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
        context_token: contextToken,
      },
      base_info: {},
    }),
    token: cfg.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
  });
}

/** Send a streaming (typewriter) message chunk. */
export async function sendMessageStreaming(
  cfg: ApiConfig,
  to: string,
  text: string,
  contextToken: string,
  clientId: string,
  done: boolean,
): Promise<void> {
  await apiFetch({
    baseUrl: cfg.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: done ? MessageState.FINISH : MessageState.GENERATING,
        item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
        context_token: contextToken,
      },
      base_info: {},
    }),
    token: cfg.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
  });
}

/** Send a "typing" indicator. */
export async function sendTyping(
  cfg: ApiConfig,
  userId: string,
  typingTicket: string,
  status: 1 | 2 = 1,
): Promise<void> {
  try {
    await apiFetch({
      baseUrl: cfg.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: typingTicket,
        status,
        base_info: {},
      }),
      token: cfg.token,
      timeoutMs: 10_000,
    });
  } catch {
    // typing is best-effort
  }
}

/** Get config (typing_ticket) for a user. */
export async function getConfig(
  cfg: ApiConfig,
  userId: string,
  contextToken?: string,
): Promise<{ typing_ticket?: string }> {
  const raw = await apiFetch({
    baseUrl: cfg.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: {},
    }),
    token: cfg.token,
    timeoutMs: 10_000,
  });
  return JSON.parse(raw);
}

// ── QR Login ─────────────────────────────────────────────────────────────────

export async function fetchQRCode(
  baseUrl = DEFAULT_BASE_URL,
  botType = "3",
): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const base = ensureTrailingSlash(baseUrl);
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`get_bot_qrcode ${res.status}`);
  return await res.json() as { qrcode: string; qrcode_img_content: string };
}

export async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<{
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}> {
  const base = ensureTrailingSlash(baseUrl);
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const raw = await res.text();
    if (!res.ok) throw new Error(`get_qrcode_status ${res.status}`);
    return JSON.parse(raw);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

/** Detect non-text media types in a message for logging and user feedback. */
export function detectMediaTypes(msg: WeixinMessage): { hasImage: boolean; hasVoice: boolean; hasFile: boolean; hasVideo: boolean } {
  const items = msg.item_list ?? [];
  return {
    hasImage: items.some(i => i.type === MessageItemType.IMAGE),
    hasVoice: items.some(i => i.type === MessageItemType.VOICE),
    hasFile:  items.some(i => i.type === MessageItemType.FILE),
    hasVideo: items.some(i => i.type === MessageItemType.VIDEO),
  };
}

/** Extract text body from a message's item_list. */
export function extractTextBody(msg: WeixinMessage): string {
  const items = msg.item_list;
  if (!items?.length) return "";
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}
