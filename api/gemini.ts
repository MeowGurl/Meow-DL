import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type GeminiResult = {
  status: "success" | "fetch_error" | "invalid_prompt";
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
let cachedBuildLabel: string | null = null;
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
          typeof blMatch === "string"
            ? blMatch
            : blMatch[1] || blMatch[0];
      }

      if (cachedAtToken) break;
    } catch {}
  }

  return { at: cachedAtToken, bl: cachedBuildLabel };
}

function parseGeminiStream(responseText: string): string {
  const lines = responseText.split("\n");
  let accumulatedText = "";

  for (const line of lines) {
    if (!line.includes("wrb.fr")) continue;
    const jsonStart = line.indexOf("[");
    if (jsonStart === -1) continue;

    try {
      const parsed = JSON.parse(line.slice(jsonStart));
      const payloadString = Array.isArray(parsed) ? parsed[0]?.[2] : null;
      if (typeof payloadString === "string") {
        const payload = JSON.parse(payloadString);
        const candidates = payload?.[4];
        if (Array.isArray(candidates) && candidates.length > 0) {
          const textCandidate = candidates[0]?.[1]?.[0];
          if (typeof textCandidate === "string" && textCandidate.trim()) {
            accumulatedText = textCandidate;
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

  return accumulatedText;
}

export async function askGemini(prompt: string): Promise<GeminiResult> {
  const totalStartTime = performance.now();
  const timings = { fetchTime: 0, totalTime: 0 };

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "invalid_prompt",
      prompt: "",
      error: "Missing prompt parameter.",
      timings,
    };
  }

  const trimmedPrompt = prompt.trim();
  const cookie = await getGeminiCookies();

  const { at, bl } = cookie
    ? await tryExtractSessionTokens(cookie)
    : { at: null, bl: null };

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
        prompt: trimmedPrompt,
        error: `Gemini Web RPC returned HTTP ${response.status}`,
        timings,
      };
    }

    const rawResponse = await response.text();
    const textOutput = parseGeminiStream(rawResponse);

    timings.totalTime = performance.now() - totalStartTime;

    if (!textOutput) {
      return {
        status: "fetch_error",
        prompt: trimmedPrompt,
        error: "Empty or unparseable response from Gemini Web.",
        timings,
      };
    }

    return {
      status: "success",
      prompt: trimmedPrompt,
      response: textOutput,
      timings,
    };
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "fetch_error",
      prompt: trimmedPrompt,
      error:
        error instanceof Error
          ? error.message
          : "Unknown network error during Gemini query.",
      timings,
    };
  }
}

export default async function handler(prompt: string) {
  return await askGemini(prompt);
}
