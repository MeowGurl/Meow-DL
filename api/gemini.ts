import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
const DEFAULT_PUSH_ID = "feeds/mcudyrk2a4khkz";

const userSessions = new Map<string, SessionContext>();
const MAX_SESSIONS = 5000;
const SESSION_TTL = 2 * 60 * 60 * 1000;

let cachedAtToken: string | null = null;
let cachedBuildLabel: string | null = null;
let cachedPushId: string = DEFAULT_PUSH_ID;
let tokenExpiresAt = 0;

function resolveModel(input?: string): string {
  if (!input) return "gemini-auto";
  const normalized = input.trim().toLowerCase();
  const map: Record<string, string> = {
    auto: "gemini-auto",
    "gemini-auto": "gemini-auto",
    flash: "gemini-flash",
    "gemini-flash": "gemini-flash",
    pro: "gemini-pro",
    "gemini-pro": "gemini-pro",
    thinking: "gemini-flash-thinking",
    "flash-thinking": "gemini-flash-thinking",
    "gemini-flash-thinking": "gemini-flash-thinking",
    advanced: "gemini-advanced",
    "gemini-advanced": "gemini-advanced",
    ultra: "gemini-advanced",
    "gemini-ultra": "gemini-advanced",
  };
  return map[normalized] || "gemini-auto";
}

function parseCookieContent(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const map = new Map<string, string>();

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

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function getGeminiCookies(): Promise<string | null> {
  for (const path of COOKIE_FILE_PATHS) {
    try {
      const content = await readFile(path, "utf-8");
      const parsed = parseCookieContent(content);
      if (parsed) return parsed;
    } catch {}
  }
  return null;
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

async function tryExtractSessionTokens(cookie: string): Promise<{
  at: string | null;
  bl: string | null;
  pushId: string;
}> {
  if (cachedAtToken && Date.now() < tokenExpiresAt) {
    return { at: cachedAtToken, bl: cachedBuildLabel, pushId: cachedPushId };
  }

  const candidateUrls = [
    "https://gemini.google.com/app",
    "https://gemini.google.com/u/0/app",
    "https://gemini.google.com/u/1/app",
  ];

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Cookie: cookie,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
        },
      });

      if (!response.ok) continue;

      const html = await response.text();
      const atMatch =
        html.match(/"SNlM0e":"([^"]+)"/) ||
        html.match(/\["SNlM0e",\s*(?:\[\],)?\s*\["([^"]+)"\]/) ||
        html.match(/["']SNlM0e["'],\s*(?:\[\],)?\s*["']([^"']+)["']/);

      const blMatch =
        html.match(/"cfb2h":"([^"]+)"/) ||
        html.match(/"bl":"([^"]+)"/) ||
        html.match(/boq_assistant-bard-web-server_[0-9a-zA-Z._-]+/);

      const pushIdMatch = html.match(/qKIAYe(?:\\?"|"):\\?"(.*?)(?:\\?"|")/);

      if (atMatch?.[1]) {
        cachedAtToken = atMatch[1];
        tokenExpiresAt = Date.now() + 30 * 60 * 1000;
      }
      if (blMatch) {
        cachedBuildLabel =
          typeof blMatch === "string" ? blMatch : blMatch[1] || blMatch[0];
      }
      if (pushIdMatch?.[1]) {
        cachedPushId = pushIdMatch[1];
      }

      if (cachedAtToken) break;
    } catch {}
  }

  return { at: cachedAtToken, bl: cachedBuildLabel, pushId: cachedPushId };
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
  const resolvedTargetModel = resolveModel(model);
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
      model: resolvedTargetModel,
      prompt: trimmedPrompt,
      response: `Chat history cleared for uid: ${cleanUid}`,
      uid: cleanUid,
      turn: 0,
      timings: { fetchTime: 0, totalTime: 0 },
    };
  }

  const totalStartTime = performance.now();
  const timings = { fetchTime: 0, totalTime: 0 };

  const cookie = await getGeminiCookies();
  const { at, bl, pushId } = cookie
    ? await tryExtractSessionTokens(cookie)
    : { at: null, bl: null, pushId: DEFAULT_PUSH_ID };

  const uploadedRefs: Array<[[string, number], string]> = [];
  if (mediaInputs.length > 0) {
    const uploadResults = await Promise.all(
      mediaInputs.map((m) => uploadMediaToGemini(m, cookie, pushId)),
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
        model: resolvedTargetModel,
        prompt: trimmedPrompt,
        uid: cleanUid,
        error: "Failed to upload media attachment to Gemini.",
        timings,
      };
    }
  }

  const reqId = Math.floor(Math.random() * 900000 + 100000).toString();

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

  const messageStruct = [
    [
      finalPrompt,
      0,
      null,
      uploadedRefs.length > 0 ? uploadedRefs : null,
      null,
      null,
      0,
    ],
    ["en"],
    [conversationId, responseId, choiceId, null, null, []],
    null,
    null,
    null,
    [1],
    0,
    [],
    [],
    1,
    0,
  ];
  const fReq = JSON.stringify([null, JSON.stringify(messageStruct)]);

  const queryParams = new URLSearchParams({
    _reqid: reqId,
    rt: "c",
  });
  if (bl) {
    queryParams.set("bl", bl);
  }

  const bodyParams = new URLSearchParams();
  bodyParams.set("f.req", fReq);
  if (at) {
    bodyParams.set("at", at);
  }

  const rpcUrl = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${queryParams.toString()}`;

  const requestHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Origin: "https://gemini.google.com",
    Referer: "https://gemini.google.com/",
    "X-Same-Domain": "1",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (cookie) {
    requestHeaders["Cookie"] = cookie;
  }

  const fetchStartTime = performance.now();

  try {
    let response = await fetch(rpcUrl, {
      method: "POST",
      headers: requestHeaders,
      body: bodyParams.toString(),
    });

    if (!response.ok && cookie && uploadedRefs.length === 0) {
      delete requestHeaders["Cookie"];
      bodyParams.delete("at");
      response = await fetch(rpcUrl, {
        method: "POST",
        headers: requestHeaders,
        body: bodyParams.toString(),
      });
    }

    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "fetch_error",
        model: resolvedTargetModel,
        prompt: trimmedPrompt,
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
        model: resolvedTargetModel,
        prompt: trimmedPrompt,
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
      model: resolvedTargetModel,
      prompt: trimmedPrompt,
      response: streamResult.text,
      ...(streamResult.images.length > 0 ? { images: streamResult.images } : {}),
      uid: cleanUid,
      turn: cleanUid ? currentTurn : undefined,
      system: activeSystem,
      timings,
    };
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "fetch_error",
      model: resolvedTargetModel,
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
