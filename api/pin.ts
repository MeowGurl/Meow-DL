import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decode } from "entities";

export type CleanedMedia = {
  type: "video" | "photo" | "gif";
  url: string;
};

export type ExtractionResult = {
  status:
    | "success"
    | "not_found"
    | "fetch_error"
    | "access_denied"
    | "rate_limited"
    | "invalid_url";
  author?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: { fetchTime: number; processTime: number; totalTime: number };
  cached?: boolean;
  error?: string;
};

export type SearchResult = {
  status: "success" | "error" | "rate_limited";
  query?: string;
  results?: Array<{
    id: string;
    title: string;
    image: string;
    url: string;
    author?: string;
    description?: string;
  }>;
  count?: number;
  timings: { fetchTime: number; processTime: number; totalTime: number };
  cached?: boolean;
  error?: string;
};

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize = 1000, ttlMs = 300000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.ttl,
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

class RateLimiter {
  private requests: Map<string, RateLimitEntry>;
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests = 30, windowMs = 60000) {
    this.requests = new Map();
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    setInterval(() => this.cleanup(), 60000);
  }

  check(identifier: string): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
  } {
    const now = Date.now();
    const entry = this.requests.get(identifier);

    if (!entry || now > entry.resetTime) {
      this.requests.set(identifier, {
        count: 1,
        resetTime: now + this.windowMs,
      });

      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: now + this.windowMs,
      };
    }

    if (entry.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
      };
    }

    entry.count++;

    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetTime: entry.resetTime,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.requests.entries()) {
      if (now > entry.resetTime) {
        this.requests.delete(key);
      }
    }
  }

  reset(identifier: string): void {
    this.requests.delete(identifier);
  }
}

const COOKIE_FILE_PATHS = [
  join(process.cwd(), "api", "pin.txt"),
  join(process.cwd(), "pin.txt"),
  join(process.cwd(), "cookies.txt"),
];

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const API_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.pinterest.com/",
  "X-Requested-With": "XMLHttpRequest",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

const pinCache = new LRUCache<ExtractionResult>(500, 5 * 60 * 1000);
const searchCache = new LRUCache<SearchResult>(200, 3 * 60 * 1000);

const pinRateLimiter = new RateLimiter(30, 60000);
const searchRateLimiter = new RateLimiter(15, 60000);

let cookieLinesCache: string[] = [];
let cookieCacheExpires = 0;
let cookieRoundRobinIndex = 0;

function parseCookieContent(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.includes("\t") || trimmed.startsWith("#")) {
    const lines = trimmed.split(/\r?\n/);
    const map = new Map<string, string>();
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
    const single = Array.from(map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    return single ? [single] : [];
  }
  const map = new Map<string, string>();
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
  const single = Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return single ? [single] : [];
}

async function getPinterestCookies(): Promise<string | null> {
  if (Date.now() > cookieCacheExpires) {
    cookieLinesCache = [];
    for (const path of COOKIE_FILE_PATHS) {
      try {
        const content = await readFile(path, "utf-8");
        const parsed = parseCookieContent(content);
        if (parsed.length > 0) {
          cookieLinesCache = parsed;
          cookieCacheExpires = Date.now() + 60 * 1000;
          break;
        }
      } catch {}
    }
  }
  if (cookieLinesCache.length === 0) return null;
  const cookie =
    cookieLinesCache[cookieRoundRobinIndex % cookieLinesCache.length];
  cookieRoundRobinIndex++;
  return cookie;
}

function cleanUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    return decode(raw.replace(/\\\//g, "/").replace(/\\u0026/g, "&").trim());
  } catch {
    return raw
      .replace(/\\\//g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .trim();
  }
}

function extractPinId(url: string): string | null {
  const match = url.match(/\/pin\/(\d+)/i) || url.match(/^(\d+)$/);
  return match ? match[1] : null;
}

async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("pin.it")) {
      const response = await fetch(url, {
        method: "HEAD",
        headers: BROWSER_HEADERS,
        redirect: "follow",
      });
      return response.url || url;
    }
    return url;
  } catch {
    return url;
  }
}

async function fetchPinResource(
  pinId: string,
  cookie: string | null,
): Promise<{
  media: CleanedMedia[];
  title?: string;
  author?: string;
  description?: string;
  thumbnail?: string;
} | null> {
  try {
    const dataParam = encodeURIComponent(
      JSON.stringify({
        options: {
          id: pinId,
          field_set_key: "detailed",
        },
        context: {},
      }),
    );
    const searchUrl = `https://www.pinterest.com/resource/PinResource/get/?data=${dataParam}`;
    const headers = {
      ...API_HEADERS,
      ...(cookie ? { Cookie: cookie } : {}),
    };

    const res = await fetch(searchUrl, { headers });
    if (!res.ok) return null;

    const json: any = await res.json();
    const pin = json?.resource_response?.data;
    if (!pin) return null;

    let videoUrl: string | undefined = undefined;
    if (pin.videos?.video_list) {
      const list = pin.videos.video_list;
      const formats = Object.values(list)
        .filter(
          (v: any) => v && typeof v === "object" && typeof v.url === "string",
        )
        .sort((a: any, b: any) => {
          const aMp4 = a.url.includes(".mp4") ? 1 : 0;
          const bMp4 = b.url.includes(".mp4") ? 1 : 0;
          if (aMp4 !== bMp4) return bMp4 - aMp4;
          return (
            (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
          );
        });
      if (formats.length > 0) {
        videoUrl = (formats[0] as any).url;
      }
    }

    let imageUrl: string | undefined =
      pin.images?.orig?.url ||
      pin.images?.["736x"]?.url ||
      pin.images?.["474x"]?.url;

    const isGif =
      pin.is_gif === true ||
      pin.is_animated === true ||
      Boolean(imageUrl && imageUrl.toLowerCase().includes(".gif"));

    const isVideo = pin.is_video === true || Boolean(videoUrl);

    const media: CleanedMedia[] = [];
    if (videoUrl || isVideo) {
      if (videoUrl) {
        media.push({ type: "video", url: cleanUrl(videoUrl)! });
      }
    } else if (isGif && imageUrl) {
      const gifUrl = imageUrl.replace(/\.(?:jpg|jpeg|png|webp)$/i, ".gif");
      media.push({ type: "gif", url: cleanUrl(gifUrl)! });
    } else if (imageUrl) {
      media.push({ type: "photo", url: cleanUrl(imageUrl)! });
    }

    if (media.length === 0) return null;

    return {
      media,
      title: pin.title || pin.grid_title || undefined,
      author: pin.pinner?.username || pin.pinner?.full_name || undefined,
      description: pin.description || pin.seo_description || undefined,
      thumbnail: cleanUrl(imageUrl),
    };
  } catch {
    return null;
  }
}

function extractFromHtml(html: string): {
  media: CleanedMedia[];
  title?: string;
  author?: string;
  description?: string;
  thumbnail?: string;
} {
  const unescaped = html.replace(/\\\//g, "/").replace(/\\u0026/g, "&");

  let videoUrl: string | undefined = undefined;
  let imageUrl: string | undefined = undefined;
  let isGif = false;
  let title: string | undefined = undefined;
  let author: string | undefined = undefined;
  let description: string | undefined = undefined;
  let thumbnail: string | undefined = undefined;

  const scriptMatches =
    html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of scriptMatches) {
    const inner = block.replace(/<\/?script[^>]*>/gi, "").trim();
    if (!inner.startsWith("{") && !inner.startsWith("[")) continue;
    try {
      const data = JSON.parse(inner);
      const queue = [data];
      while (queue.length > 0) {
        const curr = queue.shift();
        if (!curr || typeof curr !== "object") continue;

        if (curr.is_gif === true || curr.is_animated === true) {
          isGif = true;
        }

        if (curr.video_list && typeof curr.video_list === "object") {
          const formats = Object.values(curr.video_list)
            .filter(
              (v: any) =>
                v && typeof v === "object" && typeof v.url === "string",
            )
            .sort((a: any, b: any) => {
              const aMp4 = a.url.includes(".mp4") ? 1 : 0;
              const bMp4 = b.url.includes(".mp4") ? 1 : 0;
              if (aMp4 !== bMp4) return bMp4 - aMp4;
              return (
                (b.width || 0) * (b.height || 0) -
                (a.width || 0) * (a.height || 0)
              );
            });
          if (formats.length > 0 && !videoUrl) {
            videoUrl = (formats[0] as any).url;
          }
        }

        if (
          curr.orig &&
          typeof curr.orig === "object" &&
          curr.orig.url &&
          !imageUrl
        ) {
          imageUrl = curr.orig.url;
        }

        for (const val of Object.values(curr)) {
          if (val && typeof val === "object") {
            queue.push(val);
          }
        }
      }
    } catch {}
  }

  if (!videoUrl) {
    const vMatch =
      unescaped.match(
        /https?:\/\/(?:v\d*|v-cf)\.pinimg\.com\/videos\/[^\s"'\\]+\.(?:mp4|m3u8)/i,
      ) ||
      unescaped.match(
        /https?:\/\/[^\s"'\\]+\/(?:720p|exp7|480p|mc\/720p|iht\/720p)\/[^\s"'\\]+\.mp4/i,
      ) ||
      unescaped.match(/https?:\/\/[^\s"'\\]+\.mp4/i);
    if (vMatch) {
      videoUrl = vMatch[0];
    }
  }

  if (!isGif) {
    isGif =
      /"is_gif"\s*:\s*true/i.test(unescaped) ||
      /"is_animated"\s*:\s*true/i.test(unescaped) ||
      /data-is-gif="true"/i.test(unescaped);
  }

  const gifMatch = unescaped.match(
    /https?:\/\/i\.pinimg\.com\/originals\/[^\s"'\\]+\.gif/i,
  );
  if (gifMatch) {
    imageUrl = gifMatch[0];
    isGif = true;
  }

  if (!imageUrl) {
    const origMatch =
      unescaped.match(
        /https?:\/\/i\.pinimg\.com\/originals\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp|gif)/i,
      ) ||
      unescaped.match(
        /https?:\/\/i\.pinimg\.com\/736x\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp|gif)/i,
      );
    if (origMatch) {
      imageUrl = origMatch[0];
    }
  }

  if (!thumbnail) {
    thumbnail = imageUrl;
  }

  if (!title) {
    const ogTitle = html.match(
      /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i,
    );
    title = ogTitle ? cleanUrl(ogTitle[1]) : undefined;
  }

  if (!description) {
    const ogDesc = html.match(
      /<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i,
    );
    description = ogDesc ? cleanUrl(ogDesc[1]) : undefined;
  }

  const media: CleanedMedia[] = [];
  if (videoUrl) {
    media.push({ type: "video", url: cleanUrl(videoUrl)! });
  } else if (isGif && imageUrl) {
    const cleanGif = imageUrl.replace(/\.(?:jpg|jpeg|png|webp)$/i, ".gif");
    media.push({ type: "gif", url: cleanUrl(cleanGif)! });
  } else if (imageUrl) {
    media.push({ type: "photo", url: cleanUrl(imageUrl)! });
  }

  return {
    media,
    title: title ? title.replace(/\| Pinterest/gi, "").trim() : undefined,
    author,
    description,
    thumbnail: cleanUrl(thumbnail),
  };
}

export async function scrapePinterest(
  url: string,
  clientId = "default",
): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  if (!url || typeof url !== "string") {
    timings.totalTime = performance.now() - totalStartTime;
    return { status: "invalid_url", timings, error: "Invalid URL provided" };
  }

  const rateLimitResult = pinRateLimiter.check(clientId);
  if (!rateLimitResult.allowed) {
    const waitTime = Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000);
    return {
      status: "rate_limited",
      timings,
      error: `Rate limit exceeded. Try again in ${waitTime} seconds.`,
    };
  }

  const resolvedUrl = await resolveRedirectUrl(url.trim());
  const cacheKey = `pin:${resolvedUrl}`;
  const cachedResult = pinCache.get(cacheKey);

  if (cachedResult) {
    return { ...cachedResult, cached: true };
  }

  const fetchStartTime = performance.now();
  const cookie = await getPinterestCookies();
  const pinId = extractPinId(resolvedUrl);

  if (pinId) {
    const apiResult = await fetchPinResource(pinId, cookie);
    if (apiResult && apiResult.media.length > 0) {
      timings.fetchTime = performance.now() - fetchStartTime;
      timings.processTime =
        performance.now() - (fetchStartTime + timings.fetchTime);
      timings.totalTime = performance.now() - totalStartTime;

      const result: ExtractionResult = {
        status: "success",
        title: apiResult.title,
        author: apiResult.author,
        description: apiResult.description,
        thumbnail: apiResult.thumbnail,
        media: apiResult.media,
        timings,
        cached: false,
      };

      pinCache.set(cacheKey, result);
      return result;
    }
  }

  try {
    let response = await fetch(resolvedUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });

    if (
      !response.ok ||
      response.status === 403 ||
      response.status === 401
    ) {
      if (cookie) {
        response = await fetch(resolvedUrl, {
          headers: { ...BROWSER_HEADERS, Cookie: cookie },
          redirect: "follow",
        });
      }
    }

    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        return { status: "access_denied", timings };
      }
      return {
        status: "fetch_error",
        timings,
        error: `HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const processStartTime = performance.now();
    const extracted = extractFromHtml(html);

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    if (extracted.media.length === 0) {
      return { status: "not_found", timings };
    }

    const result: ExtractionResult = {
      status: "success",
      title: extracted.title,
      author: extracted.author,
      description: extracted.description,
      thumbnail: extracted.thumbnail,
      media: extracted.media,
      timings,
      cached: false,
    };

    pinCache.set(cacheKey, result);
    return result;
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "fetch_error",
      timings,
      error: error instanceof Error ? error.message : "Scraping failed",
    };
  }
}

let cachedAppVersion = "c3386b8";

function extractCookieValue(cookieStr: string | null, name: string): string | null {
  if (!cookieStr) return null;
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1].trim() : null;
}

function mergeSetCookies(baseCookie: string | null, res: Response): string {
  const map = new Map<string, string>();
  if (baseCookie) {
    for (const part of baseCookie.split(";")) {
      const clean = part.trim();
      const eq = clean.indexOf("=");
      if (eq > 0) map.set(clean.slice(0, eq).trim(), clean.slice(eq + 1).trim());
    }
  }
  const setCookies =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : [];
  for (const sc of setCookies) {
    const pair = String(sc).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extractPinsFromSearchHtml(
  html: string,
  limit: number,
): Array<{
  id: string;
  title: string;
  image: string;
  url: string;
  author?: string;
  description?: string;
}> {
  const results: Array<{
    id: string;
    title: string;
    image: string;
    url: string;
    author?: string;
    description?: string;
  }> = [];
  const seen = new Set<string>();

  const scriptMatches =
    html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of scriptMatches) {
    if (results.length >= limit) break;
    const inner = block.replace(/<\/?script[^>]*>/gi, "").trim();
    if (!inner.startsWith("{") && !inner.startsWith("[")) continue;
    try {
      const data = JSON.parse(inner);
      const queue: any[] = [data];
      while (queue.length > 0 && results.length < limit) {
        const curr = queue.shift();
        if (!curr || typeof curr !== "object") continue;

        if (curr.app_version && typeof curr.app_version === "string") {
          cachedAppVersion = curr.app_version;
        }

        if (
          (curr.type === "pin" || (curr.id && curr.images)) &&
          curr.images &&
          typeof curr.images === "object"
        ) {
          const id = String(curr.id || "");
          const img =
            curr.images.orig?.url ||
            curr.images["736x"]?.url ||
            curr.images["474x"]?.url ||
            curr.images["236x"]?.url;
          if (img && !seen.has(id || img)) {
            seen.add(id || img);
            const cleanedImg = cleanUrl(img) || img;
            const origImg = cleanedImg.replace(
              /\/(?:236x|474x|564x|736x)\//,
              "/originals/",
            );
            results.push({
              id: id || `pin-${results.length}`,
              title:
                curr.title ||
                curr.grid_title ||
                curr.seo_alt_text ||
                curr.auto_alt_text ||
                curr.description ||
                "Untitled Pin",
              image: origImg,
              url: id
                ? `https://www.pinterest.com/pin/${id}/`
                : curr.link || "",
              author: curr.pinner?.username || curr.pinner?.full_name,
              description: curr.description || curr.seo_description,
            });
          }
        }

        for (const val of Object.values(curr)) {
          if (val && typeof val === "object") queue.push(val);
        }
      }
    } catch {}
  }

  if (results.length === 0) {
    const unescaped = html.replace(/\\\//g, "/");
    const imgMatches =
      unescaped.match(
        /https:\/\/i\.pinimg\.com\/(?:originals|736x|564x|474x|236x)\/[a-f0-9/]+\.(?:jpg|jpeg|png|webp|gif)/gi,
      ) || [];
    for (const img of imgMatches) {
      if (results.length >= limit) break;
      const upgraded = img.replace(
        /\/(?:236x|474x|564x|736x)\//i,
        "/originals/",
      );
      if (!seen.has(upgraded)) {
        seen.add(upgraded);
        results.push({
          id: `pin-${results.length}`,
          title: "Pinterest Pin",
          image: upgraded,
          url: upgraded,
        });
      }
    }
  }

  return results;
}

export async function searchPinterest(
  query: string,
  clientId = "default",
  limit = 20,
): Promise<SearchResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  if (!query || typeof query !== "string") {
    return { status: "error", error: "Missing query", timings };
  }

  const rateLimitResult = searchRateLimiter.check(clientId);
  if (!rateLimitResult.allowed) {
    const waitTime = Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000);
    return {
      status: "rate_limited",
      timings,
      error: `Rate limit exceeded. Try again in ${waitTime} seconds.`,
    };
  }

  const cacheKey = `search:${query}:${limit}`;
  const cachedResult = searchCache.get(cacheKey);
  if (cachedResult) {
    return { ...cachedResult, cached: true };
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const sourceUrl = `/search/pins/?q=${encodedQuery}`;
  const searchApiUrl = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(
    JSON.stringify({
      options: {
        query: query.trim(),
        scope: "pins",
        auto_correction_disabled: false,
      },
      context: {},
    }),
  )}`;

  const fetchStartTime = performance.now();

  try {
    let cookie = await getPinterestCookies();
    let csrfToken = extractCookieValue(cookie, "csrftoken");

    const buildSearchHeaders = (c: string | null, csrf: string | null) => ({
      ...API_HEADERS,
      Referer: `https://www.pinterest.com${sourceUrl}`,
      "X-Pinterest-AppState": "active",
      "X-Pinterest-Source-Url": sourceUrl,
      "X-Pinterest-Pws-Handler": "www/search/[scope].js",
      "X-APP-VERSION": cachedAppVersion,
      ...(csrf ? { "X-CSRFToken": csrf } : {}),
      ...(c ? { Cookie: c } : {}),
    });

    let response = await fetch(searchApiUrl, {
      headers: buildSearchHeaders(cookie, csrfToken),
    });

    if (!response.ok) {
      const pageUrl = `https://www.pinterest.com${sourceUrl}`;
      const pageRes = await fetch(pageUrl, {
        headers: {
          ...BROWSER_HEADERS,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: "follow",
      });

      if (pageRes.ok) {
        const html = await pageRes.text();
        const appVerMatch = html.match(/"app_version":"([^"]+)"/);
        if (appVerMatch?.[1]) cachedAppVersion = appVerMatch[1];

        const htmlResults = extractPinsFromSearchHtml(html, limit);
        if (htmlResults.length > 0) {
          timings.fetchTime = performance.now() - fetchStartTime;
          timings.processTime =
            performance.now() - (fetchStartTime + timings.fetchTime);
          timings.totalTime = performance.now() - totalStartTime;

          const searchResult: SearchResult = {
            status: "success",
            query,
            results: htmlResults,
            count: htmlResults.length,
            timings,
            cached: false,
          };
          searchCache.set(cacheKey, searchResult);
          return searchResult;
        }

        const mergedCookie = mergeSetCookies(cookie, pageRes);
        const freshCsrf = extractCookieValue(mergedCookie, "csrftoken");
        if (freshCsrf) {
          response = await fetch(searchApiUrl, {
            headers: buildSearchHeaders(mergedCookie, freshCsrf),
          });
        }
      }
    }

    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "error",
        error: `HTTP ${response.status}`,
        timings,
      };
    }

    const processStartTime = performance.now();
    const json: any = await response.json();
    const pins = json?.resource_response?.data?.results || [];

    const results: Array<{
      id: string;
      title: string;
      image: string;
      url: string;
      author?: string;
      description?: string;
    }> = [];

    pins.slice(0, limit).forEach((pin: any) => {
      if (pin && (pin.type === "pin" || pin.id)) {
        const image =
          pin.images?.orig?.url ||
          pin.images?.["736x"]?.url ||
          pin.images?.["474x"]?.url ||
          "";
        results.push({
          id: pin.id || `pin-${results.length}`,
          title:
            pin.title || pin.grid_title || pin.description || "Untitled Pin",
          image: cleanUrl(image) || "",
          url: pin.link || `https://www.pinterest.com/pin/${pin.id}/`,
          author: pin.pinner?.username || pin.pinner?.full_name,
          description: pin.description || pin.seo_description,
        });
      }
    });

    timings.processTime = performance.now() - processStartTime;
    timings.totalTime = performance.now() - totalStartTime;

    const searchResult: SearchResult = {
      status: "success",
      query,
      results,
      count: results.length,
      timings,
      cached: false,
    };

    searchCache.set(cacheKey, searchResult);
    return searchResult;
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Search failed",
      timings,
    };
  }
}

export function getCacheStats() {
  return {
    pinCache: {
      size: pinCache.size(),
      maxSize: 500,
    },
    searchCache: {
      size: searchCache.size(),
      maxSize: 200,
    },
  };
}

export function clearCaches() {
  pinCache.clear();
  searchCache.clear();
}

export default async function handler(url: string, clientId?: string) {
  return await scrapePinterest(url, clientId);
}
