/**
 * WeChat iLink CDN media download + AES-128-ECB decryption.
 * CDN endpoint: https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=<value>
 */

import { createDecipheriv, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MessageItem } from "./weixin-api.js";

const execFileAsync = promisify(execFile);

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TEXT_EXTENSIONS = /\.(txt|md|ts|js|jsx|tsx|py|java|go|rs|c|cpp|h|hpp|json|yaml|yml|toml|xml|html|css|sh|bash|sql|csv|log|conf|ini|env)$/i;
const MAX_FILE_TEXT_LEN = 50_000;

export interface DownloadedMedia {
  type: "image" | "voice" | "file" | "video";
  mimeType: string;
  data: Buffer;
  fileName?: string;
}

function parseAesKey(rawKey: string, fromHex: boolean): Buffer {
  if (fromHex) {
    // image_item.aeskey is a 32-char hex string = 16 bytes
    return Buffer.from(rawKey, "hex");
  }
  // media.aes_key is base64-encoded; inner content may be raw 16 bytes or 32 hex chars
  const decoded = Buffer.from(rawKey, "base64");
  if (decoded.length === 16) return decoded;
  const asStr = decoded.toString("utf-8");
  if (asStr.length === 32 && /^[0-9a-fA-F]+$/.test(asStr)) {
    return Buffer.from(asStr, "hex");
  }
  return decoded.slice(0, 16);
}

function decryptAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function cdnDownload(encryptQueryParam: string): Promise<Buffer> {
  const url = `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function detectImageMime(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return "image/webp";
  return "image/jpeg";
}

export async function downloadMediaItem(item: MessageItem): Promise<DownloadedMedia | null> {
  try {
    if (item.type === 2 /* IMAGE */) {
      const img = item.image_item;
      if (!img?.media?.encrypt_query_param) return null;
      const key = img.aeskey
        ? parseAesKey(img.aeskey, true)
        : img.media.aes_key
        ? parseAesKey(img.media.aes_key, false)
        : null;
      if (!key) return null;
      const encrypted = await cdnDownload(img.media.encrypt_query_param);
      const data = decryptAes128Ecb(encrypted, key);
      return { type: "image", mimeType: detectImageMime(data), data };
    }

    if (item.type === 4 /* FILE */) {
      const file = item.file_item;
      if (!file?.media?.encrypt_query_param || !file.media.aes_key) return null;
      const key = parseAesKey(file.media.aes_key, false);
      const encrypted = await cdnDownload(file.media.encrypt_query_param);
      const data = decryptAes128Ecb(encrypted, key);
      return { type: "file", mimeType: "application/octet-stream", data, fileName: file.file_name };
    }

    if (item.type === 3 /* VOICE */) {
      const voice = item.voice_item;
      if (!voice?.media?.encrypt_query_param || !voice.media.aes_key) return null;
      const key = parseAesKey(voice.media.aes_key, false);
      const encrypted = await cdnDownload(voice.media.encrypt_query_param);
      const data = decryptAes128Ecb(encrypted, key);
      return { type: "voice", mimeType: "audio/silk", data };
    }

    if (item.type === 5 /* VIDEO */) {
      const video = item.video_item;
      if (!video?.media?.encrypt_query_param || !video.media.aes_key) return null;
      const key = parseAesKey(video.media.aes_key, false);
      const encrypted = await cdnDownload(video.media.encrypt_query_param);
      const data = decryptAes128Ecb(encrypted, key);
      return { type: "video", mimeType: "video/mp4", data };
    }
  } catch (err) {
    console.error("[cdn] 媒体下载失败:", err instanceof Error ? err.message : String(err));
  }
  return null;
}

/** Save media to a temp file and return the path. Caller must delete when done. */
export function saveTempFile(media: DownloadedMedia): string {
  const name = media.fileName ?? `wx_${media.type}_${randomUUID()}.${extFor(media)}`;
  const filePath = join(tmpdir(), name);
  writeFileSync(filePath, media.data);
  return filePath;
}

export function deleteTempFile(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* best-effort */ }
}

function extFor(media: DownloadedMedia): string {
  if (media.mimeType === "image/jpeg") return "jpg";
  if (media.mimeType === "image/png") return "png";
  if (media.mimeType === "image/gif") return "gif";
  if (media.mimeType === "image/webp") return "webp";
  return "bin";
}

// Known binary magic bytes — never treat these as text regardless of extension
const BINARY_MAGIC: [number, number[]][] = [
  [4, [0x25, 0x50, 0x44, 0x46]],         // %PDF
  [2, [0x50, 0x4B]],                       // PK (ZIP / DOCX / XLSX / PPTX)
  [4, [0xD0, 0xCF, 0x11, 0xE0]],          // DOC / XLS (old Office)
  [4, [0x89, 0x50, 0x4E, 0x47]],          // PNG
  [3, [0xFF, 0xD8, 0xFF]],                 // JPEG
  [4, [0x47, 0x49, 0x46, 0x38]],          // GIF
  [4, [0x52, 0x49, 0x46, 0x46]],          // RIFF (AVI/WAV)
];

function isBinaryMagic(buf: Buffer): boolean {
  for (const [len, bytes] of BINARY_MAGIC) {
    if (buf.length >= len && bytes.every((b, i) => buf[i] === b)) return true;
  }
  return false;
}

/**
 * Try to extract text from a file buffer.
 * Returns the text if it looks like a text file, null otherwise.
 */
export function tryReadAsText(data: Buffer, fileName?: string): string | null {
  if (isBinaryMagic(data)) return null;
  if (fileName && !TEXT_EXTENSIONS.test(fileName) && !isLikelyText(data.slice(0, 512))) {
    return null;
  }
  try {
    // Strip null bytes — they crash spawn() in claude-code and corrupt AI input
    const text = data.toString("utf-8").replace(/\0/g, "");
    if (text.length > MAX_FILE_TEXT_LEN) {
      return text.slice(0, MAX_FILE_TEXT_LEN) + "\n... [文件过长，已截断]";
    }
    return text || null;
  } catch {
    return null;
  }
}

function isLikelyText(buf: Buffer): boolean {
  let nonPrintable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0 || (b < 8) || (b > 13 && b < 32 && b !== 27)) nonPrintable++;
  }
  return buf.length === 0 || nonPrintable / buf.length < 0.1;
}

// ── Video processing ─────────────────────────────────────────────────────────

const MAX_VIDEO_SIZE = 80 * 1024 * 1024; // 80 MB
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";

export interface VideoAnalysis {
  frames: { mimeType: string; data: Buffer }[]; // extracted key frames
  transcript?: string;                           // audio transcript (if Whisper available)
  durationSec?: number;
}

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper";
const FRAMES_PER_SEC = 5;   // 1 frame every N seconds
const MAX_FRAMES = 15;
const MIN_FRAMES = 3;

const PDFTOTEXT  = process.env.PDFTOTEXT_BIN  || "pdftotext";
const PANDOC     = process.env.PANDOC_BIN     || "pandoc";
const XLSX2CSV   = process.env.XLSX2CSV_BIN   || "xlsx2csv";

// Extensions handled by pandoc (auto-detects format from extension)
const PANDOC_EXTS = new Set([".docx", ".odt", ".pptx", ".epub", ".rtf", ".doc"]);
// Extensions handled by xlsx2csv
const EXCEL_EXTS  = new Set([".xlsx", ".xls"]);

/**
 * Extract plain text from a PDF buffer using pdftotext (poppler).
 * Returns null if pdftotext is unavailable or extraction fails.
 */
async function runExtractor(
  data: Buffer,
  ext: string,
  invoke: (tmpPath: string) => Promise<string>,
): Promise<string | null> {
  const tmpPath = join(tmpdir(), `wx_doc_${randomUUID()}${ext}`);
  try {
    writeFileSync(tmpPath, data);
    const text = (await invoke(tmpPath)).trim();
    if (text.length > MAX_FILE_TEXT_LEN) {
      return text.slice(0, MAX_FILE_TEXT_LEN) + "\n... [文件过长，已截断]";
    }
    return text || null;
  } catch {
    return null;
  } finally {
    deleteTempFile(tmpPath);
  }
}

export async function extractPdfText(data: Buffer): Promise<string | null> {
  return runExtractor(data, ".pdf", async (p) => {
    const { stdout } = await execFileAsync(PDFTOTEXT, [p, "-"], { timeout: 30_000 });
    return stdout;
  });
}

async function extractWithPandoc(data: Buffer, fileName: string): Promise<string | null> {
  return runExtractor(data, extname(fileName).toLowerCase(), async (p) => {
    const { stdout } = await execFileAsync(PANDOC, ["--to=plain", "--wrap=none", p], { timeout: 30_000 });
    return stdout;
  });
}

async function extractExcelText(data: Buffer, fileName: string): Promise<string | null> {
  return runExtractor(data, extname(fileName).toLowerCase(), async (p) => {
    try {
      const { stdout } = await execFileAsync(XLSX2CSV, [p], { timeout: 30_000 });
      return stdout;
    } catch {
      const { stdout } = await execFileAsync("python3", ["-m", "xlsx2csv", p], { timeout: 30_000 });
      return stdout;
    }
  });
}

/**
 * Unified entry point: extract readable text from any file buffer.
 * Routes to the appropriate tool based on file extension.
 */
export async function extractDocumentText(data: Buffer, fileName: string): Promise<string | null> {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".pdf")             return extractPdfText(data);
  if (PANDOC_EXTS.has(ext))      return extractWithPandoc(data, fileName);
  if (EXCEL_EXTS.has(ext))       return extractExcelText(data, fileName);
  return tryReadAsText(data, fileName);
}

/**
 * Transcribe a voice message buffer (WeChat SILK audio).
 * Tries ffmpeg conversion → whisper. Returns transcript or null.
 */
export async function transcribeVoiceData(voiceData: Buffer): Promise<string | null> {
  const voicePath = join(tmpdir(), `wx_voice_${randomUUID()}.silk`);
  const tempFiles = [voicePath];
  try {
    writeFileSync(voicePath, voiceData);
    return await transcribeAudio(voicePath, tempFiles);
  } catch {
    return null;
  } finally {
    for (const f of tempFiles) deleteTempFile(f);
  }
}

/** Extract key frames + optional audio transcript from a video buffer. */
export async function extractVideoContent(videoData: Buffer): Promise<VideoAnalysis | null> {
  if (videoData.length > MAX_VIDEO_SIZE) {
    console.log(`[cdn] 视频过大 (${(videoData.length / 1024 / 1024).toFixed(1)} MB), 跳过`);
    return null;
  }

  const videoPath = join(tmpdir(), `wx_video_${randomUUID()}.mp4`);
  const tempFiles: string[] = [videoPath];

  try {
    writeFileSync(videoPath, videoData);

    const durationSec = await getVideoDuration(videoPath);

    // 1 frame per FRAMES_PER_SEC, clamped between MIN and MAX
    const count = Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.ceil(durationSec / FRAMES_PER_SEC)));
    const positions = durationSec > count
      ? Array.from({ length: count }, (_, i) => Math.floor(durationSec * (i + 0.5) / count))
      : [0];

    const frameResults = await Promise.all(positions.map(async (pos) => {
      const framePath = join(tmpdir(), `wx_frame_${randomUUID()}.jpg`);
      try {
        await execFileAsync(FFMPEG, [
          "-ss", String(pos), "-i", videoPath,
          "-vframes", "1", "-q:v", "3", "-vf", "scale=1280:-2",
          framePath, "-y",
        ]);
        tempFiles.push(framePath); // only push after file exists
        return { mimeType: "image/jpeg", data: readFileSync(framePath) };
      } catch { return null; }
    }));
    const frames = frameResults.filter((f) => f !== null) as { mimeType: string; data: Buffer }[];

    if (frames.length === 0) return null;

    // Transcribe audio: prefer local whisper, fall back to Whisper API
    const transcript = await transcribeAudio(videoPath, tempFiles) ?? undefined;

    return { frames, transcript, durationSec };
  } catch (err) {
    console.error("[cdn] 视频处理失败:", err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    for (const f of tempFiles) deleteTempFile(f);
  }
}

async function getVideoDuration(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_streams", videoPath,
    ]);
    const info = JSON.parse(stdout) as { streams?: { duration?: string }[] };
    const dur = info.streams?.find((s) => s.duration)?.duration;
    return dur ? parseFloat(dur) : 10;
  } catch {
    return 10;
  }
}

/** Try local whisper first, then Whisper API. Returns transcript or null. */
async function transcribeAudio(videoPath: string, tempFiles: string[]): Promise<string | null> {
  // Extract audio track first
  const audioPath = join(tmpdir(), `wx_audio_${randomUUID()}.mp3`);
  tempFiles.push(audioPath);
  try {
    await execFileAsync(FFMPEG, [
      "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-q:a", "5",
      audioPath, "-y",
    ]);
    const audioSize = readFileSync(audioPath).length;
    if (audioSize < 1000) return null; // no audio track
  } catch {
    return null;
  }

  // 1. Try local whisper CLI
  const localResult = await transcribeWithLocalWhisper(audioPath, tempFiles);
  if (localResult) return localResult;

  // 2. Fall back to Whisper API if OPENAI_API_KEY set
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return transcribeWithWhisperApi(audioPath, apiKey);

  return null;
}

async function transcribeWithLocalWhisper(audioPath: string, tempFiles: string[]): Promise<string | null> {
  try {
    const outDir = tmpdir();
    await execFileAsync(WHISPER_BIN, [
      audioPath,
      "--model", "base",
      "--output_format", "txt",
      "--output_dir", outDir,
      "--language", "zh",  // detect Chinese; whisper auto-detects other languages too
    ], { timeout: 120_000 });
    // whisper writes <name>.txt in outDir
    const base = audioPath.replace(/\.[^.]+$/, "");
    const txtPath = `${base}.txt`;
    tempFiles.push(txtPath);
    const text = readFileSync(txtPath, "utf-8").trim();
    console.log(`[cdn] 本地 whisper 转录完成 (${text.length} chars)`);
    return text || null;
  } catch {
    return null;
  }
}

async function transcribeWithWhisperApi(audioPath: string, apiKey: string): Promise<string | null> {
  try {
    const audioData = readFileSync(audioPath);
    const form = new FormData();
    form.append("file", new Blob([audioData], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", "whisper-1");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { text?: string };
    console.log(`[cdn] Whisper API 转录完成`);
    return data.text?.trim() || null;
  } catch {
    return null;
  }
}
