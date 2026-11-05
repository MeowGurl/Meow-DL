import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decode } from "entities";

export type CleanedMedia = {
  type: "video" | "photo";
  url: string;
};

export type ExtractionResult = {
  status: "success" | "not_found" | "fetch_error" | "invalid_url";
  author?: string | null;
  title?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
};

const COOKIE_FILE_PATHS = [
  join(process.cwd(), "api", "fb.txt"),
  join(process.cwd(), "fb.txt"),
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

const MOBILE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

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
      const parts = clean.split("\t");
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
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function getFacebookCookies(): Promise<string | null> {
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

function cleanMediaUrl(raw: string): string {
  try {
    let unescaped = raw.replace(/\\\//g, "/");
    unescaped = JSON.parse(`"${unescaped.replace(/"/g, '\\"')}"`);
    return decode(unescaped);
  } catch {
    return decode(
      raw
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/&amp;/g, "&"),
    );
  }
}

function cleanTitle(raw?: string | null): string {
  if (!raw) return "";
  let clean = decode(raw)
    .replace(/\| Facebook/gi, "")
    .replace(/ - Facebook/gi, "")
    .trim();
  if (
    clean === "Facebook" ||
    clean === "Log in to Facebook" ||
    clean === "Watch"
  ) {
    return "";
  }
  return clean.slice(0, 300);
}

function extractAuthor(html: string, title?: string): string | null {
  const authorMeta = html.match(
    /<meta\s+(?:property|name)=["']author["']\s+content=["']([^"']+)["']/i,
  );
  if (authorMeta?.[1]) return cleanTitle(authorMeta[1]);
  const reelByMatch = title?.match(/(?:reel|video)\s+by\s+([^|·-]+)/i);
  if (reelByMatch?.[1]) return reelByMatch[1].trim();
  const byAuthorMatch = title?.match(/\|\s*By\s+([^|·-]+)/i);
  if (byAuthorMatch?.[1]) return byAuthorMatch[1].trim();
  return null;
}

function extractFromHtml(html: string): {
  media: CleanedMedia[];
  title?: string;
  thumbnail?: string;
  author?: string | null;
} {
  const media: CleanedMedia[] = [];
  const hdMatch =
    html.match(
      /["']browser_native_hd_url["']\s*:\s*["'](https?:[^"']+)["']/i,
    ) ||
    html.match(
      /["']playable_url_quality_hd["']\s*:\s*["'](https?:[^"']+)["']/i,
    );
  const sdMatch =
    html.match(
      /["']browser_native_sd_url["']\s*:\s*["'](https?:[^"']+)["']/i,
    ) || html.match(/["']playable_url["']\s*:\s*["'](https?:[^"']+)["']/i);
  const ogVideoMatch = html.match(
    /<meta\s+(?:property|name)=["']og:video(?::secure_url)?["']\s+content=["'](https?:[^"']+)["']/i,
  );

  if (hdMatch) {
    media.push({ type: "video", url: cleanMediaUrl(hdMatch[1]) });
  }
  if (sdMatch) {
    const sdUrl = cleanMediaUrl(sdMatch[1]);
    if (!media.some((m) => m.url === sdUrl)) {
      media.push({ type: "video", url: sdUrl });
    }
  }
  if (media.length === 0 && ogVideoMatch) {
    media.push({ type: "video", url: cleanMediaUrl(ogVideoMatch[1]) });
  }

  const thumbMatch =
    html.match(
      /["'](?:preferred_thumbnail|thumbnail_url|thumbnail)["']\s*:\s*["'](https?:[^"']+)["']/i,
    ) ||
    html.match(
      /<meta\s+(?:property|name)=["']og:image["']\s+content=["'](https?:[^"']+)["']/i,
    );
  const thumbnail = thumbMatch ? cleanMediaUrl(thumbMatch[1]) : undefined;

  const rawTitleMatch =
    html.match(
      /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i,
    ) || html.match(/<title>([^<]+)<\/title>/i);
  const title = cleanTitle(rawTitleMatch?.[1]);
  const author = extractAuthor(html, title);

  return { media, title, thumbnail, author };
}

async function resolveCanonicalUrl(rawUrl: string): Promise<string> {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.hostname === "fb.watch" ||
      parsed.pathname.includes("/share/")
    ) {
      const response = await fetch(rawUrl, {
        method: "HEAD",
        headers: BROWSER_HEADERS,
        redirect: "follow",
      });
      return response.url || rawUrl;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

async function fetchPage(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!response.ok && response.status !== 206) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export async function scrapeFacebook(
  rawUrl: string,
  options: { metadata?: boolean } = {},
): Promise<ExtractionResult> {
  const totalStartTime = performance.now();
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };

  if (!rawUrl || typeof rawUrl !== "string") {
    timings.totalTime = performance.now() - totalStartTime;
    return { status: "invalid_url", timings };
  }

  const canonicalUrl = await resolveCanonicalUrl(rawUrl.trim());
  const pluginUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonicalUrl)}`;

  const fetchStartTime = performance.now();

  const pluginHtml = await fetchPage(pluginUrl, BROWSER_HEADERS);
  if (pluginHtml) {
    const parsed = extractFromHtml(pluginHtml);
    if (parsed.media.length > 0) {
      timings.fetchTime = performance.now() - fetchStartTime;
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "success",
        title: parsed.title,
        author: parsed.author,
        thumbnail: parsed.thumbnail,
        media: options.metadata ? [] : parsed.media,
        timings,
      };
    }
  }

  const directHtml = await fetchPage(canonicalUrl, BROWSER_HEADERS);
  if (directHtml) {
    const parsed = extractFromHtml(directHtml);
    if (parsed.media.length > 0) {
      timings.fetchTime = performance.now() - fetchStartTime;
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "success",
        title: parsed.title,
        author: parsed.author,
        thumbnail: parsed.thumbnail,
        media: options.metadata ? [] : parsed.media,
        timings,
      };
    }
  }

  const mobileUrl = canonicalUrl.replace(
    /^(https?:\/\/)(?:www\.)?facebook\.com/i,
    "$1m.facebook.com",
  );
  const mobileHtml = await fetchPage(mobileUrl, MOBILE_HEADERS);
  if (mobileHtml) {
    const parsed = extractFromHtml(mobileHtml);
    if (parsed.media.length > 0) {
      timings.fetchTime = performance.now() - fetchStartTime;
      timings.totalTime = performance.now() - totalStartTime;
      return {
        status: "success",
        title: parsed.title,
        author: parsed.author,
        thumbnail: parsed.thumbnail,
        media: options.metadata ? [] : parsed.media,
        timings,
      };
    }
  }

  const fbCookie = await getFacebookCookies();
  if (fbCookie) {
    const authHeaders = { ...BROWSER_HEADERS, Cookie: fbCookie };
    const authMobileHeaders = { ...MOBILE_HEADERS, Cookie: fbCookie };

    const authedPluginHtml = await fetchPage(pluginUrl, authHeaders);
    if (authedPluginHtml) {
      const parsed = extractFromHtml(authedPluginHtml);
      if (parsed.media.length > 0) {
        timings.fetchTime = performance.now() - fetchStartTime;
        timings.totalTime = performance.now() - totalStartTime;
        return {
          status: "success",
          title: parsed.title,
          author: parsed.author,
          thumbnail: parsed.thumbnail,
          media: options.metadata ? [] : parsed.media,
          timings,
        };
      }
    }

    const authedDirectHtml = await fetchPage(canonicalUrl, authHeaders);
    if (authedDirectHtml) {
      const parsed = extractFromHtml(authedDirectHtml);
      if (parsed.media.length > 0) {
        timings.fetchTime = performance.now() - fetchStartTime;
        timings.totalTime = performance.now() - totalStartTime;
        return {
          status: "success",
          title: parsed.title,
          author: parsed.author,
          thumbnail: parsed.thumbnail,
          media: options.metadata ? [] : parsed.media,
          timings,
        };
      }
    }

    const authedMobileHtml = await fetchPage(mobileUrl, authMobileHeaders);
    if (authedMobileHtml) {
      const parsed = extractFromHtml(authedMobileHtml);
      if (parsed.media.length > 0) {
        timings.fetchTime = performance.now() - fetchStartTime;
        timings.totalTime = performance.now() - totalStartTime;
        return {
          status: "success",
          title: parsed.title,
          author: parsed.author,
          thumbnail: parsed.thumbnail,
          media: options.metadata ? [] : parsed.media,
          timings,
        };
      }
    }
  }

  timings.fetchTime = performance.now() - fetchStartTime;
  timings.totalTime = performance.now() - totalStartTime;
  return { status: "not_found", timings };
}

export default async function handler(url: string) {
  return await scrapeFacebook(url);
}
