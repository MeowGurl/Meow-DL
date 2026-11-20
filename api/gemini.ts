import { randomUUID } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

interface ModelInfo {
  id: string;
  name: string;
  description: string;
  hash?: string;
  premium?: boolean;
}

interface CookieJar {
  [name: string]: string;
}

interface PageTokens {
  at: string | null;
  bl: string | null;
  fSid: string | null;
  pushId: string | null;
  clientPctx: string | null;
}

interface MediaInput {
  mimeType: string;
  data: Uint8Array;
  filename: string;
}

interface ClassifiedOutput {
  text: string;
  thoughts: string[];
  images: string[];
  videos: string[];
  audio: string[];
  sources: string[];
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
}

interface ChatTurn {
  role: "user" | "model";
  text: string;
}

interface SessionState {
  conversationId: string;
  responseId: string;
  choiceId: string;
  turn: number;
}

interface StoredSession extends SessionState {
  lastUsed: number;
  system?: string;
  history: ChatTurn[];
}

interface ImageTunnel {
  url: string;
  expiresAt: number;
}

export type Mode =
  | "balanced"
  | "fast"
  | "thinking"
  | "deep_research"
  | "image"
  | "image_edit"
  | "video"
  | "audio"
  | "canvas";

interface GenerationOptions {
  prompt: string;
  uid?: string;
  mode?: Mode;
  model?: string;
  system?: string;
  gemId?: string;
  media?: MediaInput[];
  temporary?: boolean;
  streaming?: boolean;
  onChunk?: (chunk: Partial<ClassifiedOutput>) => void;
}

const ORIGIN = "https://gemini.google.com";
const APP_URL = `${ORIGIN}/app`;
const STREAM_URL = `${ORIGIN}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const BATCH_URL = `${ORIGIN}/_/BardChatUi/data/batchexecute`;
const ROTATE_URL = "https://accounts.google.com/RotateCookies";
const PUSH_UPLOAD_URL = "https://push.clients6.google.com/upload/";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const COOKIE_FILE = join(process.cwd(), "api", "gemini_cookies.json");
const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;
const TOKEN_TTL = 10 * 60 * 1000;
const REFRESH_INTERVAL = 8 * 60 * 1000;
const HEALTH_CHECK_INTERVAL = 3 * 60 * 1000;
const IMAGE_TUNNEL_TTL = 5 * 60 * 60 * 1000;
const MAX_IMAGE_TUNNELS = 2000;
const MAX_REDIRECTS = 6;

const DEFAULT_MODEL_HASH = "56fdd199312815e2";
const MODEL_HASHES: Record<string, string> = {
  "3.8-flash": "56fdd199312815e2",
  "3.5-flash-lite": "cf41b0e0dd7d53e5",
  "3.1-pro": "e6fa609c3fa255c0",
};

const EMPTY_TOKENS: PageTokens = {
  at: null,
  bl: null,
  fSid: null,
  pushId: null,
  clientPctx: null,
};

const IMAGE_PLACEHOLDER = /\n?https?:\/\/googleusercontent\.com\/image_generation_content\/\d+/g;
const IMAGE_INTENT = /^(generate|create|draw|make|imagine|design|render)\b/i;

const userSessions = new Map<string, StoredSession>();
const imageTunnels = new Map<string, ImageTunnel>();

let jar: CookieJar = {};
let tokens: PageTokens = { ...EMPTY_TOKENS };
let tokenExpiresAt = 0;
let deadCookie = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;

function parseSetCookiePair(pair: string): [string, string] | null {
  const i = pair.indexOf("=");
  if (i <= 0) return null;
  return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
}

function serializeJar(c: CookieJar): string {
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function loadCookies(): Promise<CookieJar> {
  if (existsSync(COOKIE_FILE)) {
    try {
      const raw = JSON.parse(await readFile(COOKIE_FILE, "utf8"));
      const out: CookieJar = {};

      if (Array.isArray(raw)) {
        for (const c of raw) if (c.name && c.value) out[c.name] = c.value;
        return out;
      }

      if (raw.cookies && typeof raw.cookies === "object") {
        return { ...raw.cookies };
      }

      if (typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string" && !k.startsWith("updated")) out[k] = v;
        }
        return out;
      }
    } catch {}
  }

  const out: CookieJar = {};
  const psid = process.env.GEMINI_1PSID || process.env.__SECURE_1PSID;
  const psidts = process.env.GEMINI_1PSIDTS || process.env.__SECURE_1PSIDTS;
  if (psid) out["__Secure-1PSID"] = psid;
  if (psidts) out["__Secure-1PSIDTS"] = psidts;
  return out;
}

async function persistJar(next: CookieJar): Promise<void> {
  jar = next;
  try {
    await writeFile(
      COOKIE_FILE,
      JSON.stringify({ ...next, updated_at: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {}
}

function mergeSetCookies(setCookieHeaders: string[]): void {
  for (const line of setCookieHeaders) {
    const parsed = parseSetCookiePair(line.split(";")[0]);
    if (parsed) jar[parsed[0]] = parsed[1];
  }
}

function stopTimers(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function markDead(reason: string): void {
  if (deadCookie) return;
  deadCookie = true;

  console.error(
    [
      "",
      "GEMINI COOKIES ARE DEAD / EXPIRED",
      `Reason: ${reason}`,
      `Cookie file: ${COOKIE_FILE}`,
      "",
      "Manual replacement required:",
      "  1. Open https://gemini.google.com in your browser and log in.",
      "  2. DevTools > Application > Cookies > https://gemini.google.com",
      "  3. Copy __Secure-1PSID and __Secure-1PSIDTS.",
      "  4. Overwrite the JSON file above with:",
      '     { "__Secure-1PSID": "...", "__Secure-1PSIDTS": "..." }',
      "",
      "Background refresh has been paused until fresh cookies are loaded.",
      "",
    ].join("\n"),
  );

  stopTimers();
}

function isAuthFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return head.includes("accounts.google.com/signin") || head.includes("servicelogin");
}

function extractTokens(html: string): void {
  const match = (re: RegExp) => html.match(re)?.[1] ?? null;

  tokens = {
    at: match(/SNlM0e":"(.+?)"/),
    bl: match(/cfb2h":"(.+?)"/),
    fSid: match(/FdrFJe":"(-?\d+)"/),
    pushId: match(/qKIAYe":"(.+?)"/),
    clientPctx: match(/Ylro7b":"(.+?)"/),
  };

  if (tokens.at) tokenExpiresAt = Date.now() + TOKEN_TTL;
}

async function rotateCookies(): Promise<boolean> {
  if (refreshInFlight) return false;
  refreshInFlight = true;

  try {
    const psid = jar["__Secure-1PSID"];
    const psidts = jar["__Secure-1PSIDTS"];

    if (!psid) {
      markDead("__Secure-1PSID missing from cookie jar");
      return false;
    }

    const res = await fetch(ROTATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Cookie: serializeJar(jar),
        "User-Agent": USER_AGENT,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
      },
      body: JSON.stringify([psid, psidts ?? "", 1, null]),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      console.warn("[gemini] RotateCookies rate-limited; backing off");
      return false;
    }

    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return false;

    mergeSetCookies(setCookies);
    await persistJar(jar);
    deadCookie = false;
    return true;
  } catch (err) {
    console.warn("[gemini] rotateCookies failed:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    refreshInFlight = false;
  }
}

async function refreshTokens(force = false): Promise<boolean> {
  if (!force && tokens.at && Date.now() < tokenExpiresAt) return true;

  try {
    const res = await fetch(APP_URL, {
      headers: {
        Cookie: serializeJar(jar),
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    const body = await res.text();

    if (isAuthFailure(res.status, body)) {
      markDead(`Page load returned HTTP ${res.status}`);
      return false;
    }

    mergeSetCookies(res.headers.getSetCookie?.() ?? []);
    extractTokens(body);

    if (!tokens.at) {
      markDead("SNlM0e token missing from page HTML");
      return false;
    }

    deadCookie = false;
    return true;
  } catch (err) {
    console.warn("[gemini] refreshTokens failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

function sapisidHash(): string | null {
  const sapisid = jar["SAPISID"] || jar["__Secure-3PAPISID"];
  if (!sapisid) return null;

  const ts = Math.floor(Date.now() / 1000);
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`${ts} ${sapisid} ${ORIGIN}`);
  return `SAPISIDHASH ${ts}_${hasher.digest("hex")}`;
}

export function startBackgroundServices(): void {
  if (refreshTimer) return;

  refreshTimer = setInterval(async () => {
    if (deadCookie) return;
    await rotateCookies();
    await refreshTokens(true);
  }, REFRESH_INTERVAL);

  healthTimer = setInterval(async () => {
    if (deadCookie) return;
    if (!(await refreshTokens(true))) return;

    try {
      const res = await fetch(APP_URL, {
        headers: { Cookie: serializeJar(jar), "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (isAuthFailure(res.status, body)) markDead(`Health check HTTP ${res.status}`);
    } catch {}
  }, HEALTH_CHECK_INTERVAL);
}

export function stopBackgroundServices(): void {
  stopTimers();
}

async function uploadImage(media: MediaInput): Promise<unknown[] | null> {
  if (!tokens.pushId) return null;

  try {
    const res = await fetch(PUSH_UPLOAD_URL, {
      method: "POST",
      headers: {
        "Content-Type": media.mimeType,
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-Header-Content-Type": media.mimeType,
        "X-Goog-Upload-Header-Content-Length": String(media.data.length),
        "Push-ID": tokens.pushId,
        ...(tokens.clientPctx ? { "X-Client-Pctx": tokens.clientPctx } : {}),
        Cookie: serializeJar(jar),
        "User-Agent": USER_AGENT,
        Origin: ORIGIN,
      },
      body: media.data,
      signal: AbortSignal.timeout(60_000),
    });

    if (isAuthFailure(res.status, await res.text())) {
      markDead(`Upload HTTP ${res.status}`);
      return null;
    }

    const url = res.headers.get("x-goog-upload-url");
    return url ? [[media.mimeType, media.data.length], url] : null;
  } catch (err) {
    console.warn("[gemini] uploadImage failed:", err);
    return null;
  }
}

function buildPrompt(prompt: string, system: string | undefined, turn: number, mode: Mode): string {
  const base = mode === "image" && !IMAGE_INTENT.test(prompt.trim()) ? `Generate an image: ${prompt}` : prompt;
  return system && turn === 1 ? `[SYSTEM INSTRUCTION]\n${system}\n\n[USER]\n${base}` : base;
}

function buildInnerPayload(opts: {
  prompt: string;
  system?: string;
  mediaRefs: unknown[];
  session: SessionState;
  mode: Mode;
  requestId: string;
}): unknown[] {
  const { prompt, system, mediaRefs, session, mode, requestId } = opts;

  const reasoning = mode === "thinking" || mode === "deep_research" ? 2 : 1;
  const inner: unknown[] = new Array(97).fill(null);

  inner[0] = [
    buildPrompt(prompt, system, session.turn, mode),
    0,
    null,
    mediaRefs.length ? mediaRefs : null,
    null,
    null,
    0,
  ];
  inner[1] = ["en"];
  inner[2] = [
    session.conversationId,
    session.responseId,
    session.choiceId,
    null,
    null,
    null,
    null,
    null,
    null,
    "",
  ];
  inner[3] = "!";
  inner[4] = requestId.replace(/-/g, "");
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[session.turn - 1]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = requestId.toUpperCase();
  inner[61] = [];
  inner[68] = 2;
  inner[79] = reasoning;
  inner[80] = reasoning;
  inner[91] = 0;
  inner[96] = session.conversationId ? 0 : 1;

  return inner;
}

function buildStreamUrl(temporary: boolean): string {
  const qp = new URLSearchParams({
    bl: tokens.bl || "",
    "f.sid": tokens.fSid || "",
    hl: "en",
    _reqid: String(Math.floor(Math.random() * 900000) + 100000),
    rt: "c",
  });
  if (temporary) qp.set("temporary", "true");
  return `${STREAM_URL}?${qp}`;
}

function buildHeaders(modelHash: string, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent": USER_AGENT,
    Cookie: serializeJar(jar),
    Origin: ORIGIN,
    Referer: APP_URL,
    "X-Same-Domain": "1",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "x-goog-ext-525001261-jspb": JSON.stringify([1, null, null, null, modelHash, null, null, 0, [4]]),
    "x-goog-ext-525005358-jspb": JSON.stringify([requestId.toUpperCase(), 1]),
  };

  const auth = sapisidHash();
  if (auth) headers.Authorization = auth;

  return headers;
}

function parseStreamFrames(
  raw: string,
  onChunk?: (c: Partial<ClassifiedOutput>) => void,
): ClassifiedOutput {
  const out: ClassifiedOutput = {
    text: "",
    thoughts: [],
    images: [],
    videos: [],
    audio: [],
    sources: [],
  };

  for (const line of raw.split("\n")) {
    if (!line.startsWith("[")) continue;

    let rows: unknown;
    try {
      rows = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || typeof row[2] !== "string") continue;

      let data: any;
      try {
        data = JSON.parse(row[2]);
      } catch {
        continue;
      }

      if (Array.isArray(data?.[1])) {
        out.conversationId = data[1][0] ?? out.conversationId;
        out.responseId = data[1][1] ?? out.responseId;
      }

      const cand = data?.[4]?.[0];
      if (!Array.isArray(cand)) continue;

      if (typeof cand[0] === "string") out.choiceId = cand[0];
      if (typeof cand[1]?.[0] === "string") out.text = cand[1][0].replace(IMAGE_PLACEHOLDER, "").trim();

      const thought = cand[37]?.[0]?.[0];
      if (typeof thought === "string") out.thoughts = [thought];

      const urls = new Set<string>();

      for (const img of (cand[12]?.[1] ?? []) as any[]) {
        const u = img?.[0]?.[0]?.[0];
        if (typeof u === "string") urls.add(u);
      }

      for (const img of (cand[12]?.[7]?.[0] ?? []) as any[]) {
        const u = img?.[0]?.[3]?.[3];
        if (typeof u === "string") urls.add(u);
      }

      if (urls.size) out.images = [...urls];

      onChunk?.({
        text: out.text,
        thoughts: out.thoughts,
        images: out.images,
        videos: out.videos,
        audio: out.audio,
      });
    }
  }

  return out;
}

function resolveSession(uid?: string): { session: SessionState; history: ChatTurn[] } {
  const fresh = { conversationId: "", responseId: "", choiceId: "", turn: 1 };
  if (!uid) return { session: fresh, history: [] };

  const stored = userSessions.get(uid);
  if (!stored) return { session: fresh, history: [] };

  if (Date.now() - stored.lastUsed >= SESSION_TTL) {
    userSessions.delete(uid);
    return { session: fresh, history: [] };
  }

  return {
    session: {
      conversationId: stored.conversationId,
      responseId: stored.responseId,
      choiceId: stored.choiceId,
      turn: (stored.turn || 0) + 1,
    },
    history: stored.history,
  };
}

function saveSession(
  uid: string,
  session: SessionState,
  parsed: ClassifiedOutput,
  opts: GenerationOptions,
  history: ChatTurn[],
): void {
  if (userSessions.size >= MAX_SESSIONS) {
    const oldest = userSessions.keys().next().value;
    if (oldest) userSessions.delete(oldest);
  }

  userSessions.set(uid, {
    conversationId: parsed.conversationId || session.conversationId,
    responseId: parsed.responseId || session.responseId,
    choiceId: parsed.choiceId || session.choiceId,
    turn: session.turn,
    lastUsed: Date.now(),
    system: opts.system,
    history: [
      ...history,
      { role: "user" as const, text: opts.prompt },
      { role: "model" as const, text: parsed.text },
    ].slice(-20),
  });
}

export async function generate(
  opts: GenerationOptions,
): Promise<ClassifiedOutput | { error: string }> {
  if (deadCookie) {
    return {
      error:
        "Cookies are marked dead. Replace api/gemini_cookies.json manually and call reloadCookies().",
    };
  }

  if (!(await refreshTokens(false))) {
    return { error: "Authentication failed. Cookies are likely expired." };
  }

  const modelHash = (opts.model && MODEL_HASHES[opts.model]) || DEFAULT_MODEL_HASH;
  const mode: Mode = opts.mode ?? "balanced";
  const temporary = opts.temporary ?? false;
  const requestId = randomUUID();
  const { session, history } = resolveSession(opts.uid);

  const mediaRefs: unknown[] = [];
  for (const media of opts.media ?? []) {
    const ref = await uploadImage(media);
    if (ref) mediaRefs.push(ref);
  }

  const inner = buildInnerPayload({
    prompt: opts.prompt,
    system: opts.system,
    mediaRefs,
    session,
    mode,
    requestId,
  });

  const body = new URLSearchParams();
  body.set("f.req", JSON.stringify([null, JSON.stringify(inner)]));
  body.set("at", tokens.at || "");

  let res: Response;
  try {
    res = await fetch(buildStreamUrl(temporary), {
      method: "POST",
      headers: buildHeaders(modelHash, requestId),
      body: body.toString(),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return { error: `Network error: ${err instanceof Error ? err.message : "unknown"}` };
  }

  const raw = await res.text();

  if (isAuthFailure(res.status, raw)) {
    markDead(`StreamGenerate HTTP ${res.status}`);
    return { error: `Authentication failed (HTTP ${res.status}). Cookies expired.` };
  }

  mergeSetCookies(res.headers.getSetCookie?.() ?? []);
  await persistJar(jar);

  if (!res.ok) {
    return { error: `StreamGenerate HTTP ${res.status}: ${raw.slice(0, 300)}` };
  }

  const parsed = parseStreamFrames(raw, opts.onChunk);

  if (!parsed.text && parsed.images.length === 0) {
    return { error: `Empty reply from Gemini: ${raw.slice(0, 400)}` };
  }

  if (opts.uid) saveSession(opts.uid, session, parsed, opts, history);

  return parsed;
}

export async function deepResearch(
  prompt: string,
  uid?: string,
): Promise<ClassifiedOutput | { error: string }> {
  const first = await generate({ prompt, uid, mode: "deep_research" });
  if ("error" in first) return first;

  if (!first.conversationId || !first.responseId) {
    return { error: "Deep Research: missing conversation/response IDs from initial turn" };
  }

  const startBody = new URLSearchParams();
  startBody.set(
    "f.req",
    JSON.stringify([
      JSON.stringify([
        null,
        JSON.stringify([
          ["Start research", 0, null, null, null, null, 0],
          ["en"],
          [
            first.conversationId,
            first.responseId,
            first.choiceId ?? null,
            null,
            null,
            null,
            null,
            null,
            null,
            "",
          ],
          "",
        ]),
      ]),
    ]),
  );
  startBody.set("at", tokens.at || "");

  const query = new URLSearchParams({
    rpcids: "kwDCne",
    "source-path": `/app/${first.conversationId}`,
    bl: tokens.bl || "",
    "f.sid": tokens.fSid || "",
    hl: "en",
    rt: "c",
  });

  let startRes: Response;
  try {
    startRes = await fetch(`${BATCH_URL}?${query}`, {
      method: "POST",
      headers: buildHeaders(DEFAULT_MODEL_HASH, randomUUID()),
      body: startBody.toString(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { error: `Network error: ${err instanceof Error ? err.message : "unknown"}` };
  }

  const startRaw = await startRes.text();

  if (isAuthFailure(startRes.status, startRaw)) {
    markDead(`Deep Research start HTTP ${startRes.status}`);
    return { error: "Authentication failed during Deep Research start." };
  }

  return {
    ...first,
    text:
      `${first.text}\n\n[deep_research] Research task acknowledged. ` +
      "Polling finalisation is account- and version-dependent; " +
      "use the conversation ID above to retrieve the final report via a follow-up turn.",
  };
}

function sweepImageTunnels(): void {
  const now = Date.now();
  for (const [id, tunnel] of imageTunnels) {
    if (tunnel.expiresAt <= now) imageTunnels.delete(id);
  }
  while (imageTunnels.size >= MAX_IMAGE_TUNNELS) {
    const oldest = imageTunnels.keys().next().value;
    if (!oldest) break;
    imageTunnels.delete(oldest);
  }
}

function isGoogleHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith("google.com") || host.endsWith("googleusercontent.com");
  } catch {
    return false;
  }
}

function withFullSize(url: string): string {
  const needsSize = url.includes("googleusercontent.com") && !/=[a-z]\d+/i.test(url.split("/").pop() ?? "");
  return needsSize ? `${url}=s2048` : url;
}

async function fetchWithCookies(startUrl: string): Promise<Response> {
  let current = withFullSize(startUrl);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Referer: `${ORIGIN}/`,
    };
    if (isGoogleHost(current)) headers.Cookie = serializeJar(jar);

    const res = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }

    return res;
  }

  throw new Error("Too many redirects while fetching image.");
}

export function createImageTunnel(url: string): string {
  sweepImageTunnels();
  const id = randomUUID();
  imageTunnels.set(id, { url, expiresAt: Date.now() + IMAGE_TUNNEL_TTL });
  return id;
}

export async function streamImageTunnel(id: string): Promise<Response | null> {
  const tunnel = imageTunnels.get(id);
  if (!tunnel) return null;

  if (tunnel.expiresAt <= Date.now()) {
    imageTunnels.delete(id);
    return null;
  }

  try {
    const upstream = await fetchWithCookies(tunnel.url);

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { success: false, error: `Image fetch failed with HTTP ${upstream.status}.` },
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    const extension = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
    const headers = new Headers({
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="gemini-${id.slice(0, 8)}.${extension}"`,
      "Cache-Control": "private, max-age=3600",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("Content-Length", length);

    return new Response(upstream.body, { headers });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Image fetch failed." },
      { status: 502 },
    );
  }
}

export async function initialize(): Promise<{ ok: boolean; reason?: string }> {
  jar = await loadCookies();

  if (!jar["__Secure-1PSID"]) {
    markDead("__Secure-1PSID not found in cookie file or environment");
    return { ok: false, reason: "missing __Secure-1PSID" };
  }

  if (!(await refreshTokens(true))) {
    return { ok: false, reason: "token extraction failed" };
  }

  startBackgroundServices();
  return { ok: true };
}

export async function reloadCookies(): Promise<{ ok: boolean; reason?: string }> {
  deadCookie = false;
  tokens = { ...EMPTY_TOKENS };
  tokenExpiresAt = 0;
  return initialize();
}

export function isDead(): boolean {
  return deadCookie;
}

export function listModels(): ModelInfo[] {
  return [
    {
      id: "3.8-flash",
      name: "3.8 Flash",
      description: "Default balanced model.",
      hash: MODEL_HASHES["3.8-flash"],
    },
    {
      id: "3.5-flash-lite",
      name: "3.5 Flash-Lite",
      description: "Faster, lighter responses.",
      hash: MODEL_HASHES["3.5-flash-lite"],
    },
    {
      id: "3.1-pro",
      name: "3.1 Pro",
      description: "Deeper reasoning.",
      hash: MODEL_HASHES["3.1-pro"],
      premium: true,
    },
  ];
}