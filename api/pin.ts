import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decode } from "entities";

export type CleanedMedia = {
  type: "video" | "photo";
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
  return decode(raw.replace(/\\\//g, "/").replace(/\\u0026/g, "&").trim());
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

function extractFromHtml(html: string): {
  media: CleanedMedia[];
  title?: string;
  author?: string;
  description?: string;
  thumbnail?: string;
} {
  let videoUrl: string | undefined = undefined;
  let imageUrl: string | undefined = undefined;
  let title: string | undefined = undefined;
  let author: string | undefined = undefined;
  let description: string | undefined = undefined;
  let thumbnail: string | undefined = undefined;

  const ldMatches =
    html.match(
      /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) || [];

  for (const block of ldMatches) {
    try {
      const content = block.replace(/<\/?script[^>]*>/gi, "").trim();
      const data = JSON.parse(content);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (
          item["@type"] &&
          (item["@type"].includes("VideoObject") ||
            item["@type"].includes("Pin") ||
            item["@type"].includes("ImageObject"))
        ) {
          title = title || item.name || item.headline || item.title;
          description = description || item.description;
          author =
            author ||
            item.author?.name ||
            item.creator?.name ||
            item.publisher?.name;
          thumbnail = thumbnail || item.thumbnailUrl || item.thumbnail;
          if (
            item.contentUrl &&
            (item.contentUrl.includes(".mp4") ||
              item["@type"].includes("VideoObject"))
          ) {
            videoUrl = item.contentUrl;
          }
          imageUrl = imageUrl || item.contentUrl || item.image;
        }
      }
    } catch {}
  }

  if (!videoUrl) {
    const vMatch =
      html.match(
        /https?:\/\/[^"'\s\\]+\/(?:720p|exp7|480p|mc\/720p)\/[^"'\s\\]+\.mp4/i,
      ) ||
      html.match(
        /https?:\/\/v\.pinimg\.com\/videos\/(?:mc\/)?[^"'\s\\]+\.mp4/i,
      );
    if (vMatch) {
      videoUrl = cleanUrl(vMatch[0]);
    }
  }

  if (!imageUrl) {
    const origMatch =
      html.match(
        /https?:\/\/i\.pinimg\.com\/originals\/[^"'\s\\]+\.(?:jpg|png|webp)/i,
      ) ||
      html.match(
        /https?:\/\/i\.pinimg\.com\/736x\/[^"'\s\\]+\.(?:jpg|png|webp)/i,
      );
    if (origMatch) {
      imageUrl = cleanUrl(origMatch[0]);
    }
  }

  if (!thumbnail) {
    thumbnail = imageUrl;
  }

  if (!title) {
    const ogTitle = html.match(
      /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i,
    );
    title = ogTitle ? decode(ogTitle[1]) : undefined;
  }

  if (!description) {
    const ogDesc = html.match(
      /<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i,
    );
    description = ogDesc ? decode(ogDesc[1]) : undefined;
  }

  const media: CleanedMedia[] = [];
  if (videoUrl) {
    media.push({ type: "video", url: cleanUrl(videoUrl)! });
  }
  if (imageUrl && (!videoUrl || imageUrl !== videoUrl)) {
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

  try {
    let response = await fetch(resolvedUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });

    if (
      (!response.ok || response.status === 403 || response.status === 401)
    ) {
      const cookie = await getPinterestCookies();
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
  const searchUrl = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=/search/pins/?q=${encodedQuery}&data=${encodeURIComponent(
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
    const cookie = await getPinterestCookies();
    const headers = {
      ...API_HEADERS,
      ...(cookie ? { Cookie: cookie } : {}),
    };

    const response = await fetch(searchUrl, {
      headers,
    });

    timings.fetchTime = performance.now() - fetchStartTime;

    if (!response.ok) {
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
