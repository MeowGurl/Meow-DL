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

const userSessions = new Map<string, SessionContext>();
const MAX_SESSIONS = 5000;
const SESSION_TTL = 2 * 60 * 60 * 1000;

let cachedAtToken: string | null = null;
let cachedBuildLabel: string | null = null;
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
}> {
  if (cachedAtToken && Date.now() < tokenExpiresAt) {
    return { at: cachedAtToken, bl: cachedBuildLabel };
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

      if (atMatch?.[1]) {
        cachedAtToken = atMatch[1];
        tokenExpiresAt = Date.now() + 30 * 60 * 1000;
      }
      if (blMatch) {
        cachedBuildLabel =
          typeof blMatch === "string" ? blMatch : blMatch[1] || blMatch[0];
      }

      if (cachedAtToken) break;
    } catch {}
  }

  return { at: cachedAtToken, bl: cachedBuildLabel };
}

function parseGeminiStream(responseText: string): {
  text: string;
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
} {
  const lines = responseText.split("\n");
  let accumulatedText = "";
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
            choiceId = choiceId || candidates[0]?.[0];
            const textCandidate = candidates[0]?.[1]?.[0];
            if (typeof textCandidate === "string" && textCandidate.trim()) {
              accumulatedText = textCandidate;
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
    text: accumulatedText,
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
): Promise<GeminiResult> {
  const resolvedTargetModel = resolveModel(model);
  const cleanUid = uid ? String(uid).trim() : undefined;
  const inputSystem = system ? String(system).trim() : undefined;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return {
      status: "info",
      message: "Provide a prompt query parameter to generate a response.",
      example:
        "/g?prompt=Your+Question&model=gemini-flash&uid=12345&system=You+are+Queen+AI",
      defaultModel: "gemini-auto",
      availableModels: AVAILABLE_MODELS,
    };
  }

  const trimmedPrompt = prompt.trim();
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
  const { at, bl } = cookie
    ? await tryExtractSessionTokens(cookie)
    : { at: null, bl: null };

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
  if (activeSystem && (currentTurn === 1 || inputSystem)) {
    finalPrompt = `[System Directive: ${activeSystem}]\n\n${trimmedPrompt}`;
  }

  const messageStruct = [
    [finalPrompt, 0, null, null, null, null, 0],
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

    if (!response.ok && cookie) {
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

    if (!streamResult.text) {
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
) {
  return await askGemini(prompt, model, uid, system);
}
