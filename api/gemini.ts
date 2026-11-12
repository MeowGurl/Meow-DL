import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type ModelInfo = {
  id: string;
  name: string;
  description: string;
};

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: "gemini-auto",
    name: "Gemini Auto (Default)",
    description: "Adaptive routing balancing speed and depth according to query complexity.",
  },
  {
    id: "gemini-flash",
    name: "Gemini Flash",
    description: "Ultra-fast response model optimized for quick answers and high throughput.",
  },
  {
    id: "gemini-pro",
    name: "Gemini Pro",
    description: "Advanced reasoning, complex coding, mathematics, and detailed synthesis.",
  },
  {
    id: "gemini-flash-thinking",
    name: "Gemini Flash Thinking",
    description: "Extended deliberation model showing detailed step-by-step thinking.",
  },
  {
    id: "gemini-advanced",
    name: "Gemini Advanced / Ultra",
    description: "Flagship tier for complex multi-step reasoning and deep analysis.",
  },
];

export type GeminiResult =
  | {
      status: "info";
      message: string;
      example: string;
      defaultModel: string;
      availableModels: ModelInfo[];
    }
  | {
      status: "success";
      model: string;
      prompt: string;
      response: string;
      images?: string[];
      authenticated?: boolean;
      uid?: string;
      turn?: number;
      system?: string;
      timings: {
        fetchTime: number;
        totalTime: number;
      };
    }
  | {
      status: "fetch_error" | "invalid_prompt";
      model: string;
      prompt: string;
      authenticated?: boolean;
      uid?: string;
      error: string;
      timings: {
        fetchTime: number;
        totalTime: number;
      };
    };

interface SessionContext {
  conversationId: string;
  responseId: string;
  choiceId: string;
  turn: number;
  lastUsed: number;
  system?: string;
}

const COOKIE_FILE_PATHS = [
  join(process.cwd(), "api", "gemini.txt"),
  join(process.cwd(), "gemini.txt"),
  join(process.cwd(), "cookies.txt"),
];

const SYSTEM_FILE_PATHS = [
  join(process.cwd(), "api", "system.txt"),
  join(process.cwd(), "system.txt"),
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const UPLOAD_URL = "https://content-push.googleapis.com/upload/";
const ROTATE_COOKIES_URL = "https://accounts.google.com/RotateCookies";
const DEFAULT_PUSH_ID = "feeds/mcudyrk2a4khkz";

const userSessions = new Map<string, SessionContext>();
const MAX_SESSIONS = 5000;
const SESSION_TTL = 2 * 60 * 60 * 1000;

let cachedCookieHeader: string | null = null;
let cachedAtToken: string | null = null;
let cachedBuildLabel: string | null = null;
let cachedPushId: string = DEFAULT_PUSH_ID;
let tokenExpiresAt = 0;

function resolveModel(input?: string): { id: string; mode: number; expandedThinking: boolean } {
  if (!input) return { id: "gemini-auto", mode: 4, expandedThinking: false };
  const normalized = input.trim().toLowerCase();
  const map: Record<string, { id: string; mode: number; expandedThinking: boolean }> = {
    auto: { id: "gemini-auto", mode: 4, expandedThinking: false },
    "gemini-auto": { id: "gemini-auto", mode: 4, expandedThinking: false },
    flash: { id: "gemini-flash", mode: 1, expandedThinking: false },
    "gemini-flash": { id: "gemini-flash", mode: 1, expandedThinking: false },
    pro: { id: "gemini-pro", mode: 3, expandedThinking: false },
    "gemini-pro": { id: "gemini-pro", mode: 3, expandedThinking: false },
    thinking: { id: "gemini-flash-thinking", mode: 2, expandedThinking: true },
    "flash-thinking": { id: "gemini-flash-thinking", mode: 2, expandedThinking: true },
    "gemini-flash-thinking": { id: "gemini-flash-thinking", mode: 2, expandedThinking: true },
    advanced: { id: "gemini-advanced", mode: 3, expandedThinking: false },
    "gemini-advanced": { id: "gemini-advanced", mode: 3, expandedThinking: false },
    ultra: { id: "gemini-advanced", mode: 3, expandedThinking: false },
    "gemini-ultra": { id: "gemini-advanced", mode: 3, expandedThinking: false },
  };
  return map[normalized] || { id: "gemini-auto", mode: 4, expandedThinking: false };
}

function parseCookieMap(raw: string): Map<string, string> {
  const trimmed = raw.trim();
  const map = new Map<string, string>();
  if (!trimmed) return map;

  if (trimmed.includes("\t") || trimmed.startsWith("#")) {
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const parts = clean.split("\t");
      if (parts.length >= 7) {
        const name = parts[5].trim();
        const value = parts[6].trim();
        if (name && value) map.set(name, value);
      }
    }
  } else {
    for (const item of trimmed.split(";")) {
      const clean = item.trim();
      if (!clean) continue;
      const eq = clean.indexOf("=");
      if (eq > 0) {
        const k = clean.slice(0, eq).trim();
        const v = clean.slice(eq + 1).trim();
        if (k && v) map.set(k, v);
      }
    }
  }
  return map;
}

function serializeCookieMap(map: Map<string, string>): string {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function makeSapisidHash(cookie: string): string | null {
  const map = parseCookieMap(cookie);
  const sapisid = map.get("SAPISID") || map.get("__Secure-1PAPISID");
  if (!sapisid) return null;
  const ts = Math.floor(Date.now() / 1000);
  const digest = createHash("sha1")
    .update(`${ts} ${sapisid} https://gemini.google.com`)
    .digest("hex");
  return `SAPISIDHASH ${ts}_${digest}`;
}

async function getGeminiCookies(): Promise<string | null> {
  if (cachedCookieHeader) return cachedCookieHeader;
  if (process.env.GEMINI_COOKIE?.trim()) {
    const parsed = serializeCookieMap(parseCookieMap(process.env.GEMINI_COOKIE));
    if (parsed) {
      cachedCookieHeader = parsed;
      return parsed;
    }
  }
  for (const path of COOKIE_FILE_PATHS) {
    try {
      const content = await readFile(path, "utf-8");
      const parsed = serializeCookieMap(parseCookieMap(content));
      if (parsed) {
        cachedCookieHeader = parsed;
        return parsed;
      }
    } catch {}
  }
  return null;
}

async function rotateCookies(cookie: string): Promise<string> {
  try {
    const res = await fetch(ROTATE_COOKIES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Cookie: cookie,
      },
      body: '[000,"-0000000000000000000"]',
    });
    if (!res.ok) return cookie;
    const setCookies =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : [];
    if (Array.isArray(setCookies) && setCookies.length > 0) {
      const map = parseCookieMap(cookie);
      for (const sc of setCookies) {
        const pair = String(sc).split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const k = pair.slice(0, eq).trim();
          const v = pair.slice(eq + 1).trim();
          if (k && v) map.set(k, v);
        }
      }
      const updated = serializeCookieMap(map);
      cachedCookieHeader = updated;
      return updated;
    }
  } catch {}
  return cookie;
}

async function getDefaultSystemInstruction(): Promise<string | null> {
  if (process.env.GEMINI_SYSTEM_INSTRUCTION?.trim()) {
    return process.env.GEMINI_SYSTEM_INSTRUCTION.trim();
  }
  for (const path of SYSTEM_FILE_PATHS) {
    try {
      const content = await readFile(path, "utf-8");
      if (content.trim()) return content.trim();
    } catch {}
  }
  return null;
}

async function tryExtractSessionTokens(
  cookie: string,
  forceRefresh = false,
): Promise<{
  at: string | null;
  bl: string | null;
  pushId: string;
  cookie: string;
}> {
  if (!forceRefresh && cachedAtToken && Date.now() < tokenExpiresAt) {
    return {
      at: cachedAtToken,
      bl: cachedBuildLabel,
      pushId: cachedPushId,
      cookie,
    };
  }

  let activeCookie = cookie;
  const candidateUrls = [
    "https://gemini.google.com/app",
    "https://gemini.google.com/u/0/app",
    "https://gemini.google.com/u/1/app",
  ];

  const extractFromUrls = async (c: string) => {
    for (const url of candidateUrls) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Cookie: c,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
          },
          redirect: "follow",
        });

        if (!response.ok) continue;

        const html = await response.text();
        const atMatch =
          html.match(/"SNlM0e":"([^"]+)"/) ||
          html.match(/SNlM0e(?:\\?"|"):\\?"(.*?)(?:\\?"|")/) ||
          html.match(/\["SNlM0e",\s*(?:\[\],)?\s*\["([^"]+)"\]/) ||
          html.match(/["']SNlM0e["'],\s*(?:\[\],)?\s*["']([^"']+)["']/);

        const blMatch =
          html.match(/"cfb2h":"([^"]+)"/) ||
          html.match(/"bl":"([^"]+)"/) ||
          html.match(/boq_assistant-bard-web-server_[0-9a-zA-Z._-]+/);

        const pushIdMatch = html.match(/qKIAYe(?:\\?"|"):\\?"(.*?)(?:\\?"|")/);

        if (atMatch?.[1]) {
          cachedAtToken = atMatch[1];
          tokenExpiresAt = Date.now() + 20 * 60 * 1000;
        }
        if (blMatch) {
          cachedBuildLabel =
            typeof blMatch === "string" ? blMatch : blMatch[1] || blMatch[0];
        }
        if (pushIdMatch?.[1]) {
          cachedPushId = pushIdMatch[1];
        }

        if (cachedAtToken) return true;
      } catch {}
    }
    return false;
  };

  let found = await extractFromUrls(activeCookie);
  if (!found) {
    activeCookie = await rotateCookies(activeCookie);
    found = await extractFromUrls(activeCookie);
  }

  return {
    at: cachedAtToken,
    bl: cachedBuildLabel,
    pushId: cachedPushId,
    cookie: activeCookie,
  };
}

function inferFilenameFromMime(mime: string, fallbackUrl?: string): string {
  if (fallbackUrl) {
    try {
      const pathname = new URL(fallbackUrl).pathname;
      const base = pathname.split("/").pop();
      if (base && base.includes(".")) return base.slice(0, 64);
    } catch {}
  }
  const cleanMime = mime.toLowerCase().split(";")[0].trim();
  const extMap: Record<string, string> = {
    "image/jpeg": "image.jpg",
    "image/jpg": "image.jpg",
    "image/png": "image.png",
    "image/webp": "image.webp",
    "image/gif": "image.gif",
    "video/mp4": "video.mp4",
    "video/webm": "video.webm",
    "audio/mpeg": "audio.mp3",
    "audio/mp3": "audio.mp3",
    "audio/wav": "audio.wav",
    "audio/ogg": "audio.ogg",
    "application/pdf": "document.pdf",
  };
  return extMap[cleanMime] || "upload.bin";
}

async function resolveMediaBytes(
  input: string,
): Promise<{ buffer: Uint8Array; fileName: string } | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("data:")) {
    const match = trimmed.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return null;
    const mime = match[1] || "image/png";
    const isBase64 = Boolean(match[2]);
    const raw = match[3];
    const buffer = isBase64
      ? Uint8Array.from(Buffer.from(raw, "base64"))
      : Uint8Array.from(Buffer.from(decodeURIComponent(raw), "utf-8"));
    return { buffer, fileName: inferFilenameFromMime(mime) };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const res = await fetch(trimmed, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return {
      buffer: new Uint8Array(arrayBuffer),
      fileName: inferFilenameFromMime(contentType, trimmed),
    };
  }

  return null;
}

async function uploadMediaToGemini(
  mediaInput: string,
  cookie: string | null,
  pushId: string,
): Promise<[string, string] | null> {
  try {
    const resolved = await resolveMediaBytes(mediaInput);
    if (!resolved || resolved.buffer.byteLength === 0) return null;

    const baseHeaders: Record<string, string> = {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.7",
      authorization: "Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: "https://gemini.google.com",
      "push-id": pushId || DEFAULT_PUSH_ID,
      referer: "https://gemini.google.com/",
      "user-agent": USER_AGENT,
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(resolved.buffer.byteLength),
      "x-goog-upload-protocol": "resumable",
      "x-tenant-id": "bard-storage",
      size: String(resolved.buffer.byteLength),
    };

    if (cookie) {
      baseHeaders["Cookie"] = cookie;
    }

    const startRes = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: baseHeaders,
      body: `File name: ${resolved.fileName}`,
    });

    if (!startRes.ok) return null;

    const uploadUrl = startRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) return null;

    const finalizeHeaders: Record<string, string> = {
      ...baseHeaders,
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    };

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: finalizeHeaders,
      body: resolved.buffer,
    });

    if (!uploadRes.ok) return null;

    const identifier = (await uploadRes.text()).trim();
    if (!identifier) return null;

    return [identifier, resolved.fileName];
  } catch {
    return null;
  }
}

function cleanResponseText(text: string): string {
  return text
    .replace(/\[Imagen of .*?\]/g, "")
    .replace(
      /https?:\/\/googleusercontent\.com\/(?:image_generation|youtube|map)_content\/\d+/g,
      "",
    )
    .replace(/<!-- end list -->/g, "")
    .replace(
      /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
      "",
    )
    .trim();
}

function parseGeminiStream(responseText: string): {
  text: string;
  images: string[];
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
} {
  const lines = responseText.split("\n");
  let accumulatedText = "";
  const images: string[] = [];
  const seenImages = new Set<string>();
  let conversationId: string | undefined = undefined;
  let responseId: string | undefined = undefined;
  let choiceId: string | undefined = undefined;

  for (const line of lines) {
    if (!line.includes("wrb.fr")) continue;
    const jsonStart = line.indexOf("[");
    if (jsonStart === -1) continue;

    try {
      const parsed = JSON.parse(line.slice(jsonStart));
      const payloadString = Array.isArray(parsed) ? parsed[0]?.[2] : null;
      if (typeof payloadString === "string") {
        const payload = JSON.parse(payloadString);
        if (Array.isArray(payload)) {
          if (Array.isArray(payload[1])) {
            conversationId = conversationId || payload[1][0];
            responseId = responseId || payload[1][1];
          }
          const candidates = payload[4];
          if (Array.isArray(candidates) && candidates.length > 0) {
            const firstCandidate = candidates[0];
            choiceId = choiceId || firstCandidate?.[0];
            const textCandidate = firstCandidate?.[1]?.[0];
            if (typeof textCandidate === "string" && textCandidate.trim()) {
              accumulatedText = textCandidate;
            }
            const generatedGroup = firstCandidate?.[12]?.[7]?.[0];
            if (Array.isArray(generatedGroup)) {
              for (const imgObj of generatedGroup) {
                const imgData = imgObj?.[0]?.[3]?.[3];
                let rawImgUrl: string | undefined;
                if (Array.isArray(imgData)) {
                  rawImgUrl = imgData.find(
                    (item) =>
                      typeof item === "string" && item.startsWith("http"),
                  );
                } else if (
                  typeof imgData === "string" &&
                  imgData.startsWith("http")
                ) {
                  rawImgUrl = imgData;
                }
                if (rawImgUrl) {
                  const fullUrl = rawImgUrl.includes("=s")
                    ? rawImgUrl
                    : `${rawImgUrl}=s2048`;
                  if (!seenImages.has(fullUrl)) {
                    seenImages.add(fullUrl);
                    images.push(fullUrl);
                  }
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  if (!accumulatedText) {
    const rawMatches = responseText.match(/"rc_[^"]+","([^"]+)"/);
    if (rawMatches?.[1]) {
      try {
        accumulatedText = JSON.parse(`"${rawMatches[1]}"`);
      } catch {
        accumulatedText = rawMatches[1];
      }
    }
  }

  if (images.length === 0) {
    const fallbackImgMatches =
      responseText.match(
        /https:\/\/lh3\.googleusercontent\.com\/(?:gg-dl|rd-gg)\/[A-Za-z0-9_=-]+/g,
      ) || [];
    for (const url of fallbackImgMatches) {
      const fullUrl = url.includes("=s") ? url : `${url}=s2048`;
      if (!seenImages.has(fullUrl)) {
        seenImages.add(fullUrl);
        images.push(fullUrl);
      }
    }
  }

  if (!conversationId) {
    const cMatch = responseText.match(/c_[a-zA-Z0-9_-]+/);
    if (cMatch) conversationId = cMatch[0];
  }
  if (!responseId) {
    const rMatch = responseText.match(/r_[a-zA-Z0-9_-]+/);
    if (rMatch) responseId = rMatch[0];
  }
  if (!choiceId) {
    const rcMatch = responseText.match(/rc_[a-zA-Z0-9_-]+/);
    if (rcMatch) choiceId = rcMatch[0];
  }

  return {
    text: cleanResponseText(accumulatedText),
    images,
    conversationId,
    responseId,
    choiceId,
  };
}

export function resetSession(uid: string): boolean {
  if (!uid) return false;
  return userSessions.delete(String(uid).trim());
}

export function getSessionStats() {
  return {
    activeSessions: userSessions.size,
    maxSessions: MAX_SESSIONS,
  };
}

export async function askGemini(
  prompt?: string,
  model?: string,
  uid?: string,
  system?: string,
  media?: string | string[],
): Promise<GeminiResult> {
  const resolvedModel = resolveModel(model);
  const cleanUid = uid ? String(uid).trim() : undefined;
  const inputSystem = system ? String(system).trim() : undefined;

  const mediaInputs = Array.isArray(media)
    ? media.filter((m) => typeof m === "string" && m.trim())
    : typeof media === "string" && media.trim()
      ? [media.trim()]
      : [];

  if (
    (!prompt || typeof prompt !== "string" || !prompt.trim()) &&
    mediaInputs.length === 0
  ) {
    return {
      status: "info",
      message: "Provide a prompt query parameter to generate a response.",
      example:
        "/g?prompt=Your+Question&model=gemini-flash&uid=12345&system=You+are+Queen+AI&media=https://example.com/image.jpg",
      defaultModel: "gemini-auto",
      availableModels: AVAILABLE_MODELS,
    };
  }

  const trimmedPrompt =
    prompt && prompt.trim()
      ? prompt.trim()
      : "Analyze and describe this media in detail.";
  const lowerPrompt = trimmedPrompt.toLowerCase();

  if (cleanUid && (lowerPrompt === "clear" || lowerPrompt === "reset")) {
    userSessions.delete(cleanUid);
    return {
      status: "success",
      model: resolvedModel.id,
      prompt: trimmedPrompt,
      response: `Chat history cleared for uid: ${cleanUid}`,
      uid: cleanUid,
      turn: 0,
      timings: { fetchTime: 0, totalTime: 0 },
    };
  }

  const totalStartTime = performance.now();
  const timings = { fetchTime: 0, totalTime: 0 };

  let cookie = await getGeminiCookies();
  let sessionTokens = cookie
    ? await tryExtractSessionTokens(cookie)
    : { at: null, bl: null, pushId: DEFAULT_PUSH_ID, cookie: "" };
  if (cookie && sessionTokens.cookie) {
    cookie = sessionTokens.cookie;
  }

  const uploadedRefs: Array<[[string, number], string]> = [];
  if (mediaInputs.length > 0) {
    const uploadResults = await Promise.all(
      mediaInputs.map((m) => uploadMediaToGemini(m, cookie, sessionTokens.pushId)),
    );
    for (const ref of uploadResults) {
      if (ref) {
        uploadedRefs.push([[ref[0], 1], ref[1]]);
      }
    }
    if (uploadedRefs.length === 0) {
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "fetch_error",
        model: resolvedModel.id,
        prompt: trimmedPrompt,
        authenticated: Boolean(sessionTokens.at),
        uid: cleanUid,
        error: "Failed to upload media attachment to Gemini.",
        timings,
      };
    }
  }

  let conversationId = "";
  let responseId = "";
  let choiceId = "";
  let currentTurn = 1;
  let activeSystem = inputSystem;

  if (cleanUid && userSessions.has(cleanUid)) {
    const existing = userSessions.get(cleanUid)!;
    if (Date.now() - existing.lastUsed < SESSION_TTL) {
      conversationId = existing.conversationId || "";
      responseId = existing.responseId || "";
      choiceId = existing.choiceId || "";
      currentTurn = (existing.turn || 0) + 1;
      activeSystem = inputSystem || existing.system;
    } else {
      userSessions.delete(cleanUid);
    }
  }

  if (!activeSystem) {
    const defaultSys = await getDefaultSystemInstruction();
    if (defaultSys) activeSystem = defaultSys;
  }

  let finalPrompt = trimmedPrompt;
  if (activeSystem) {
    if (currentTurn === 1 || inputSystem) {
      finalPrompt = `[CRITICAL ROLEPLAY & IDENTITY DIRECTIVE]\nYou must strictly embody the following persona for all responses: "${activeSystem}".\nMandatory Constraints:\n1. Never break character. Never refer to yourself as Gemini or state that you are an AI developed by Google.\n2. When asked who you are, what your name is, or who created you, answer strictly and solely as your designated persona.\n3. Embody this persona fully in your tone, style, and identity.\n\nUser: ${trimmedPrompt}\n\nAssistant:`;
    }
  }

  const buildRequestPayload = (
    atToken: string | null,
    blLabel: string | null,
  ) => {
    const reqId = Math.floor(Math.random() * 900000 + 100000).toString();
    const requestUuid = randomUUID().toUpperCase();
    const inner: any[] = new Array(97).fill(null);
    inner[0] = [
      finalPrompt,
      0,
      null,
      uploadedRefs.length > 0 ? uploadedRefs : null,
      null,
      null,
      0,
    ];
    inner[1] = ["en"];
    inner[2] = [
      conversationId,
      responseId,
      choiceId,
      null,
      null,
      null,
      null,
      null,
      null,
      "",
    ];
    inner[6] = [1];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[currentTurn - 1]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    inner[41] = [1];
    inner[53] = 0;
    inner[59] = requestUuid;
    inner[61] = [];
    inner[68] = 2;
    inner[79] = resolvedModel.mode;
    inner[80] = resolvedModel.expandedThinking ? 2 : 1;
    inner[91] = 0;
    inner[96] = conversationId ? 0 : 1;

    const fReq = JSON.stringify([null, JSON.stringify(inner)]);
    const queryParams = new URLSearchParams({
      _reqid: reqId,
      hl: "en",
      rt: "c",
    });
    if (blLabel) {
      queryParams.set("bl", blLabel);
    }

    const bodyParams = new URLSearchParams();
    bodyParams.set("f.req", fReq);
    if (atToken) {
      bodyParams.set("at", atToken);
    }

    return {
      rpcUrl: `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${queryParams.toString()}`,
      body: bodyParams.toString(),
      requestUuid,
    };
  };

  const buildHeaders = (activeCookie: string | null, requestUuid: string) => {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Origin: "https://gemini.google.com",
      Referer: "https://gemini.google.com/app",
      "X-Same-Domain": "1",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "x-goog-ext-525005358-jspb": `["${requestUuid}",1]`,
    };
    if (activeCookie) {
      headers["Cookie"] = activeCookie;
      const sapisidHash = makeSapisidHash(activeCookie);
      if (sapisidHash) {
        headers["Authorization"] = sapisidHash;
      }
    }
    return headers;
  };

  const fetchStartTime = performance.now();

  try {
    let usedAuthenticated = Boolean(cookie && sessionTokens.at);
    let reqData = buildRequestPayload(
      usedAuthenticated ? sessionTokens.at : null,
      sessionTokens.bl,
    );
    let response = await fetch(reqData.rpcUrl, {
      method: "POST",
      headers: buildHeaders(
        usedAuthenticated ? cookie : null,
        reqData.requestUuid,
      ),
      body: reqData.body,
    });

    if (!response.ok && cookie) {
      cachedAtToken = null;
      tokenExpiresAt = 0;
      const refreshed = await tryExtractSessionTokens(cookie, true);
      if (refreshed.at) {
        cookie = refreshed.cookie;
        sessionTokens = refreshed;
        usedAuthenticated = true;
        reqData = buildRequestPayload(refreshed.at, refreshed.bl);
        response = await fetch(reqData.rpcUrl, {
          method: "POST",
          headers: buildHeaders(cookie, reqData.requestUuid),
          body: reqData.body,
        });
      }
    }

    if (!response.ok && cookie && uploadedRefs.length === 0) {
      usedAuthenticated = false;
      reqData = buildRequestPayload(null, sessionTokens.bl);
      response = await fetch(reqData.rpcUrl, {
        method: "POST",
        headers: buildHeaders(null, reqData.requestUuid),
        body: reqData.body,
      });
    }

    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "fetch_error",
        model: resolvedModel.id,
        prompt: trimmedPrompt,
        authenticated: usedAuthenticated,
        uid: cleanUid,
        error: `Gemini Web RPC returned HTTP ${response.status}`,
        timings,
      };
    }

    const rawResponse = await response.text();
    const streamResult = parseGeminiStream(rawResponse);

    timings.totalTime = performance.now() - totalStartTime;

    if (!streamResult.text && streamResult.images.length === 0) {
      return {
        status: "fetch_error",
        model: resolvedModel.id,
        prompt: trimmedPrompt,
        authenticated: usedAuthenticated,
        uid: cleanUid,
        error: "Empty or unparseable response from Gemini Web.",
        timings,
      };
    }

    if (cleanUid) {
      if (userSessions.size >= MAX_SESSIONS) {
        const oldestKey = userSessions.keys().next().value;
        if (oldestKey !== undefined) userSessions.delete(oldestKey);
      }
      userSessions.set(cleanUid, {
        conversationId: streamResult.conversationId || conversationId,
        responseId: streamResult.responseId || responseId,
        choiceId: streamResult.choiceId || choiceId,
        turn: currentTurn,
        lastUsed: Date.now(),
        system: activeSystem,
      });
    }

    return {
      status: "success",
      model: resolvedModel.id,
      prompt: trimmedPrompt,
      response: streamResult.text,
      ...(streamResult.images.length > 0 ? { images: streamResult.images } : {}),
      authenticated: usedAuthenticated,
      uid: cleanUid,
      turn: cleanUid ? currentTurn : undefined,
      system: activeSystem,
      timings,
    };
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "fetch_error",
      model: resolvedModel.id,
      prompt: trimmedPrompt,
      uid: cleanUid,
      error:
        error instanceof Error
          ? error.message
          : "Unknown network error during Gemini query.",
      timings,
    };
  }
}

export default async function handler(
  prompt?: string,
  model?: string,
  uid?: string,
  system?: string,
  media?: string | string[],
) {
  return await askGemini(prompt, model, uid, system, media);
}
