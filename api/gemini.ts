import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type GeminiResult = {
  status: "success" | "fetch_error" | "auth_error" | "invalid_prompt";
  prompt: string;
  response?: string;
  error?: string;
  timings: {
    fetchTime: number;
    totalTime: number;
  };
};

const COOKIE_FILE_PATHS = [
  join(process.cwd(), "api", "gemini.txt"),
  join(process.cwd(), "gemini.txt"),
  join(process.cwd(), "cookies.txt"),
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let cachedAtToken: string | null = null;
let cachedBuildLabel = "boq_assistant-bard-web-server_20261103.00_p0";
let tokenExpiresAt = 0;

function parseCookieContent(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const map = new Map<string, string>();

  if (trimmed.includes("\t") || trimmed.startsWith("#")) {
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const parts = line.split("\t");
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

async function getSessionTokens(cookie: string): Promise<{
  at: string | null;
  bl: string;
}> {
  if (cachedAtToken && Date.now() < tokenExpiresAt) {
    return { at: cachedAtToken, bl: cachedBuildLabel };
  }

  const response = await fetch("https://gemini.google.com/app", {
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: cookie,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to initialize Gemini session: HTTP ${response.status}`);
  }

  const html = await response.text();
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  const blMatch = html.match(/"cfb2h":"([^"]+)"/) || html.match(/"bl":"([^"]+)"/);

  if (atMatch?.[1]) {
    cachedAtToken = atMatch[1];
    tokenExpiresAt = Date.now() + 30 * 60 * 1000;
  }

  if (blMatch?.[1]) {
    cachedBuildLabel = blMatch[1];
  }

  return { at: cachedAtToken, bl: cachedBuildLabel };
}

function parseGeminiStream(responseText: string): string {
  const lines = responseText.split("\n");
  let accumulatedText = "";

  for (const line of lines) {
    if (!line.startsWith('[["wrb.fr"')) continue;
    try {
      const parsed = JSON.parse(line);
      const dataStr = parsed[0][2];
      if (typeof dataStr === "string") {
        const inner = JSON.parse(dataStr);
        const candidates = inner[4];
        if (Array.isArray(candidates) && candidates.length > 0) {
          const textPart = candidates[0][1]?.[0];
          if (typeof textPart === "string") {
            accumulatedText = textPart;
          }
        }
      }
    } catch {}
  }

  return accumulatedText;
}

export async function askGemini(prompt: string): Promise<GeminiResult> {
  const totalStartTime = performance.now();
  const timings = { fetchTime: 0, totalTime: 0 };

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    timings.totalTime = performance.now() - totalStartTime;
    return { status: "invalid_prompt", prompt: "", error: "Missing prompt parameter.", timings };
  }

  const trimmedPrompt = prompt.trim();
  const cookie = await getGeminiCookies();

  if (!cookie) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "auth_error",
      prompt: trimmedPrompt,
      error: "No cookies found in api/gemini.txt or cookies.txt. Please supply Google session cookies.",
      timings,
    };
  }

  try {
    const { at, bl } = await getSessionTokens(cookie);

    if (!at) {
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "auth_error",
        prompt: trimmedPrompt,
        error: "Failed to extract Gemini XSRF token (SNlM0e). Your cookies may be expired.",
        timings,
      };
    }

    const reqId = Math.floor(Math.random() * 900000 + 100000).toString();
    const messageStruct = [
      [trimmedPrompt, 0, null, null, null, null, 0],
      ["en"],
      ["", "", "", null, null, []],
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

    const params = new URLSearchParams({
      bl,
      _reqid: reqId,
      rt: "c",
    });

    const body = new URLSearchParams({
      "f.req": fReq,
      at,
    });

    const fetchStartTime = performance.now();
    const rpcUrl = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params.toString()}`;

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Origin: "https://gemini.google.com",
        Referer: "https://gemini.google.com/",
        "X-Same-Domain": "1",
      },
      body: body.toString(),
    });

    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "fetch_error",
        prompt: trimmedPrompt,
        error: `Gemini RPC returned HTTP ${response.status}`,
        timings,
      };
    }

    const rawText = await response.text();
    const generatedText = parseGeminiStream(rawText);

    timings.totalTime = performance.now() - totalStartTime;

    if (!generatedText) {
      return {
        status: "fetch_error",
        prompt: trimmedPrompt,
        error: "Empty or unrecognized response payload from Gemini Web.",
        timings,
      };
    }

    return {
      status: "success",
      prompt: trimmedPrompt,
      response: generatedText,
      timings,
    };
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "fetch_error",
      prompt: trimmedPrompt,
      error: error instanceof Error ? error.message : "Unknown error occurred while contacting Gemini.",
      timings,
    };
  }
}

export default async function handler(prompt: string) {
  return await askGemini(prompt);
}
