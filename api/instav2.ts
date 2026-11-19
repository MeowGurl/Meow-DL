import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const INSTAGRAM_API_V1 = "https://www.instagram.com/api/v1/media";
const INSTAGRAM_GRAPHQL_URL = "https://www.instagram.com/api/graphql";
const COOKIE_FILE_PATHS = [
  join(process.cwd(), "api", "insta.txt"),
  join(process.cwd(), "insta.txt"),
];

const BASE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "X-IG-App-ID": "936619743392459",
  "X-ASBD-ID": "359341",
  "X-IG-WWW-Claim": "0",
  Origin: "https://www.instagram.com",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

const HTML_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

const GRAPHQL_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.5",
  "Content-Type": "application/x-www-form-urlencoded",
  "X-FB-Friendly-Name": "PolarisPostActionLoadPostQueryQuery",
  "X-CSRFToken": "RVDUooU5MYsBbS1CNN3CzVAuEP8oHB52",
  "X-IG-App-ID": "1217981644879628",
  "X-FB-LSD": "AVqbxe3J_YA",
  "X-ASBD-ID": "129477",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36",
};

const STATIC_GRAPHQL_PARAMS = {
  av: "0",
  __d: "www",
  __user: "0",
  __a: "1",
  __req: "3",
  __hs: "19624.HYP:instagram_web_pkg.2.1..0.0",
  dpr: "3",
  __ccg: "UNKNOWN",
  __rev: "1008824440",
  __s: "xf44ne:zhh75g:xr51e7",
  __hsi: "7282217488877343271",
  __dyn:
    "7xeUmwlEnwn8K2WnFw9-2i5U4e0yoW3q32360CEbo1nEhw2nVE4W0om78b87C0yE5ufz81s8hwGwQwoEcE7O2l0Fwqo31w9a9x-0z8-U2zxe2GewGwso88cobEaU2eUlwhEe87q7-0iK2S3qazo7u1xwIw8O321LwTwKG1pg661pwr86C1mwraCg",
  __csr:
    "gZ3yFmJkillQvV6ybimnG8AmhqujGbLADgjyEOWz49z9XDlAXBJpC7Wy-vQTSvUGWGh5u8KibG44dBiigrgjDxGjU0150Q0848azk48N09C02IR0go4SaR70r8owyg9pU0V23hwiA0LQczA48S0f-x-27o05NG0fkw",
  __comet_req: "7",
  lsd: "AVqbxe3J_YA",
  jazoest: "2957",
  __spin_r: "1008824440",
  __spin_b: "trunk",
  __spin_t: "1695523385",
  fb_api_caller_class: "RelayModern",
  fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
  server_timestamps: "true",
  doc_id: "10015901848480474",
};

const STATIC_GRAPHQL_BODY = new URLSearchParams(STATIC_GRAPHQL_PARAMS).toString();

type CleanedMedia = {
  type: "video" | "photo";
  url: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  duration?: number;
};

type Comment = {
  text: string;
  author: string;
  timestamp: number;
};

type OwnerInfo = {
  username?: string;
  fullName?: string;
  profilePicUrl?: string;
  isVerified?: boolean;
  followersCount?: number;
};

type MusicInfo = {
  title?: string;
  artist?: string;
  audioUrl?: string;
  isOriginal?: boolean;
};

export type ExtractionResult = {
  status: "success" | "not_found" | "fetch_error" | "invalid_url" | "blocked";
  error_details?: string;
  author?: string;
  owner?: OwnerInfo;
  title?: string;
  thumbnail?: string;
  media?: CleanedMedia[];
  likeCount?: number;
  commentCount?: number;
  viewCount?: number;
  timestamp?: number;
  music?: MusicInfo;
  comments?: Comment[];
  cached?: boolean;
  timings: {
    fetchTime: number;
    processTime: number;
    totalTime: number;
  };
};

const postCache = new Map<
  string,
  { result: ExtractionResult; expires: number }
>();
const CACHE_TTL_MS = 15 * 60 * 1000;

let cookieLinesCache: string[] = [];
let cookieCacheExpires = 0;
let cookieRoundRobinIndex = 0;

async function getRotatedInstagramHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...BASE_HEADERS };

  if (Date.now() > cookieCacheExpires) {
    cookieLinesCache = [];
    for (const path of COOKIE_FILE_PATHS) {
      try {
        const rawFile = await readFile(path, "utf-8");
        const lines = rawFile
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        if (lines.length > 0) {
          cookieLinesCache = lines;
          cookieCacheExpires = Date.now() + 60 * 1000;
          break;
        }
      } catch {}
    }
  }

  if (cookieLinesCache.length > 0) {
    const selectedCookie =
      cookieLinesCache[cookieRoundRobinIndex % cookieLinesCache.length];
    cookieRoundRobinIndex++;

    headers["Cookie"] = selectedCookie;
    const csrfMatch = selectedCookie.match(/csrftoken=([^;\s]+)/);
    if (csrfMatch?.[1]) {
      headers["X-CSRFToken"] = csrfMatch[1];
    }
  }

  return headers;
}

async function resolveRedirectUrl(url: string): Promise<string> {
  if (!url.includes("/share/")) return url;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": BASE_HEADERS["User-Agent"] },
    });
    return res.url || url;
  } catch {
    return url;
  }
}

function shortcodeToMediaId(shortcode: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = 0n;
  for (let i = 0; i < shortcode.length; i++) {
    id = id * 64n + BigInt(alphabet.indexOf(shortcode[i]));
  }
  return id.toString();
}

function extractShortcodeFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const postMatch = url.pathname.match(
      /\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i,
    );
    if (postMatch?.[1]) {
      let code = postMatch[1];
      if (code.length > 28) {
        code = code.substring(0, code.length - 28);
      }
      return code;
    }
    return null;
  } catch {
    return null;
  }
}

function extractMediaIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);

    const storyQueryParam = url.searchParams.get("story_media_id");
    if (storyQueryParam && /^\d+$/.test(storyQueryParam)) {
      return storyQueryParam;
    }

    const storyPathMatch = url.pathname.match(
      /\/stories\/[^\/]+\/(\d+)/i,
    );
    if (storyPathMatch?.[1]) {
      return storyPathMatch[1];
    }

    const highlightMatch = url.pathname.match(
      /\/stories\/highlights\/(\d+)/i,
    );
    if (highlightMatch?.[1]) {
      return highlightMatch[1];
    }

    const postMatch = url.pathname.match(
      /\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/i,
    );
    if (postMatch?.[1]) {
      let code = postMatch[1];
      if (code.length > 28) {
        code = code.substring(0, code.length - 28);
      }
      return /^\d+$/.test(code) ? code : shortcodeToMediaId(code);
    }

    const directNumericMatch = url.pathname.match(/\/(\d{10,25})(?:\/|$)/);
    if (directNumericMatch?.[1]) {
      return directNumericMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

function extractMediaFromV1Item(item: any): CleanedMedia[] {
  const mediaList: CleanedMedia[] = [];

  if (item.carousel_media) {
    for (const carouselItem of item.carousel_media) {
      mediaList.push(...extractMediaFromV1Item(carouselItem));
    }
    return mediaList;
  }

  const isVideo = item.media_type === 2 || Boolean(item.video_versions);

  const bestImage = item.image_versions2?.candidates?.[0]?.url;
  const width =
    item.original_width || item.image_versions2?.candidates?.[0]?.width;
  const height =
    item.original_height || item.image_versions2?.candidates?.[0]?.height;

  if (isVideo && item.video_versions?.length > 0) {
    const bestVideo = item.video_versions[0];
    mediaList.push({
      type: "video",
      url: bestVideo.url,
      thumbnail: bestImage,
      width: bestVideo.width || width,
      height: bestVideo.height || height,
      duration: item.video_duration,
    });
  } else if (bestImage) {
    mediaList.push({
      type: "photo",
      url: bestImage,
      thumbnail: bestImage,
      width,
      height,
    });
  }

  return mediaList;
}

function extractMediaFromGraphqlNode(node: any): CleanedMedia[] {
  if (!node) return [];
  const edges = node.edge_sidecar_to_children?.edges;
  if (Array.isArray(edges) && edges.length > 0) {
    return edges.flatMap((edge: any) => extractMediaFromGraphqlNode(edge?.node));
  }
  if (node.is_video || node.video_url) {
    return node.video_url
      ? [
          {
            type: "video",
            url: node.video_url,
            thumbnail: node.display_url,
            width: node.dimensions?.width,
            height: node.dimensions?.height,
            duration: node.video_duration,
          },
        ]
      : [];
  }
  const src = node.display_resources?.at?.(-1)?.src || node.display_url;
  return src
    ? [
        {
          type: "photo",
          url: src,
          thumbnail: src,
          width: node.dimensions?.width,
          height: node.dimensions?.height,
        },
      ]
    : [];
}

function buildResultFromV1Item(
  item: any,
  timings: { fetchTime: number; processTime: number; totalTime: number },
): ExtractionResult | null {
  const mediaUrls = extractMediaFromV1Item(item);
  if (mediaUrls.length === 0) return null;

  const ownerObj: OwnerInfo = {
    username: item.user?.username || item.owner?.username,
    fullName: item.user?.full_name || item.owner?.full_name,
    profilePicUrl: item.user?.profile_pic_url || item.owner?.profile_pic_url,
    isVerified: item.user?.is_verified || item.owner?.is_verified,
    followersCount: item.user?.follower_count,
  };

  const captionText =
    typeof item.caption === "string"
      ? item.caption
      : item.caption?.text || "";

  let musicInfo: MusicInfo | undefined = undefined;
  if (item.clips_metadata?.music_info?.music_asset_info) {
    const asset = item.clips_metadata.music_info.music_asset_info;
    musicInfo = {
      title: asset.title,
      artist: asset.display_artist,
      audioUrl: asset.progressive_download_url,
      isOriginal: asset.is_original_audio,
    };
  } else if (item.clips_metadata?.original_sound_info) {
    const sound = item.clips_metadata.original_sound_info;
    musicInfo = {
      title: sound.original_audio_title,
      artist: sound.ig_artist?.username,
      audioUrl: sound.progressive_download_url,
      isOriginal: true,
    };
  }

  return {
    status: "success",
    author: ownerObj.username,
    owner: ownerObj,
    title: captionText,
    thumbnail:
      mediaUrls[0]?.thumbnail || item.image_versions2?.candidates?.[0]?.url,
    media: mediaUrls,
    likeCount: item.like_count,
    commentCount: item.comment_count,
    viewCount: item.view_count || item.play_count,
    timestamp: item.taken_at,
    music: musicInfo,
    cached: false,
    timings,
  };
}

function buildResultFromGraphqlNode(
  node: any,
  timings: { fetchTime: number; processTime: number; totalTime: number },
): ExtractionResult | null {
  const mediaUrls = extractMediaFromGraphqlNode(node);
  if (mediaUrls.length === 0) return null;

  const ownerObj: OwnerInfo = {
    username: node.owner?.username,
    fullName: node.owner?.full_name,
    profilePicUrl: node.owner?.profile_pic_url,
    isVerified: node.owner?.is_verified,
  };

  const captionText =
    node.edge_media_to_caption?.edges?.[0]?.node?.text || "";

  return {
    status: "success",
    author: ownerObj.username,
    owner: ownerObj,
    title: captionText,
    thumbnail: node.display_url || mediaUrls[0]?.thumbnail,
    media: mediaUrls,
    likeCount: node.edge_media_preview_like?.count,
    commentCount: node.edge_media_to_parent_comment?.count,
    viewCount: node.video_view_count || node.video_play_count,
    timestamp: node.taken_at_timestamp,
    cached: false,
    timings,
  };
}

function findMediaObjectInScripts(
  html: string,
  timings: { fetchTime: number; processTime: number; totalTime: number },
): ExtractionResult | null {
  const scriptMatches =
    html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const block of scriptMatches) {
    const inner = block.replace(/<\/?script[^>]*>/gi, "").trim();
    if (!inner.startsWith("{") && !inner.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(inner);
      const queue: any[] = [parsed];
      let visited = 0;

      while (queue.length > 0 && visited < 4000) {
        const curr = queue.shift();
        visited++;
        if (!curr || typeof curr !== "object") continue;

        if (curr.video_versions || curr.carousel_media || curr.image_versions2) {
          const v1Res = buildResultFromV1Item(curr, timings);
          if (v1Res) return v1Res;
        }

        if (curr.xdt_shortcode_media) {
          const gqlRes = buildResultFromGraphqlNode(
            curr.xdt_shortcode_media,
            timings,
          );
          if (gqlRes) return gqlRes;
        }

        if (curr.shortcode_media) {
          const gqlRes = buildResultFromGraphqlNode(
            curr.shortcode_media,
            timings,
          );
          if (gqlRes) return gqlRes;
        }

        if (curr.video_url || (curr.display_url && curr.is_video !== undefined)) {
          const gqlRes = buildResultFromGraphqlNode(curr, timings);
          if (gqlRes) return gqlRes;
        }

        for (const val of Object.values(curr)) {
          if (val && typeof val === "object") queue.push(val);
        }
      }
    } catch {}
  }

  const unescaped = html.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
  const ogVideo =
    unescaped.match(
      /<meta\s+(?:property|name)=["']og:video(?::secure_url)?["']\s+content=["']([^"']+)["']/i,
    )?.[1] ||
    unescaped.match(/"video_url"\s*:\s*"(https?:[^"]+)"/i)?.[1];
  const ogImage = unescaped.match(
    /<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i,
  )?.[1];
  const ogTitle = unescaped.match(
    /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i,
  )?.[1];

  if (ogVideo) {
    return {
      status: "success",
      title: ogTitle || "",
      thumbnail: ogImage,
      media: [{ type: "video", url: ogVideo, thumbnail: ogImage }],
      cached: false,
      timings,
    };
  }

  return null;
}

async function fetchFromHtmlFallback(
  shortcode: string,
  timings: { fetchTime: number; processTime: number; totalTime: number },
  totalStartTime: number,
  fetchStartTime: number,
): Promise<ExtractionResult | null> {
  const candidateUrls = [
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/p/${shortcode}/`,
  ];

  for (const pageUrl of candidateUrls) {
    try {
      const res = await fetch(pageUrl, {
        method: "GET",
        headers: HTML_HEADERS,
        redirect: "manual",
      });

      if (!res.ok) continue;

      const html = await res.text();
      timings.fetchTime = performance.now() - fetchStartTime;
      const processStart = performance.now();
      const extracted = findMediaObjectInScripts(html, timings);
      timings.processTime = performance.now() - processStart;
      timings.totalTime = performance.now() - totalStartTime;

      if (extracted) {
        return extracted;
      }
    } catch {}
  }

  return null;
}

async function fetchFromGraphqlFallback(
  shortcode: string,
  timings: { fetchTime: number; processTime: number; totalTime: number },
  totalStartTime: number,
  fetchStartTime: number,
): Promise<ExtractionResult | null> {
  try {
    const variables = {
      shortcode,
      fetch_comment_count: null,
      fetch_related_profile_media_count: null,
      parent_comment_count: null,
      child_comment_count: null,
      fetch_like_count: null,
      fetch_tagged_user_count: null,
      fetch_preview_comment_count: null,
      has_threaded_comments: false,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    };
    const body = `${STATIC_GRAPHQL_BODY}&${new URLSearchParams({
      variables: JSON.stringify(variables),
    }).toString()}`;

    const res = await fetch(INSTAGRAM_GRAPHQL_URL, {
      method: "POST",
      headers: GRAPHQL_HEADERS,
      body,
      redirect: "manual",
    });

    if (!res.ok) return null;

    timings.fetchTime = performance.now() - fetchStartTime;
    const processStart = performance.now();
    const json: any = await res.json();
    const mediaData = json?.data?.xdt_shortcode_media;
    if (!mediaData) return null;

    const extracted = buildResultFromGraphqlNode(mediaData, timings);
    timings.processTime = performance.now() - processStart;
    timings.totalTime = performance.now() - totalStartTime;
    return extracted;
  } catch {
    return null;
  }
}

export async function scrapeInstagram(
  rawUrl: string,
): Promise<ExtractionResult> {
  const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
  const totalStartTime = performance.now();

  if (!rawUrl || typeof rawUrl !== "string") {
    timings.totalTime = performance.now() - totalStartTime;
    return { status: "invalid_url", timings };
  }

  const resolvedUrl = await resolveRedirectUrl(rawUrl.trim());
  const mediaId = extractMediaIdFromUrl(resolvedUrl);
  const shortcode = extractShortcodeFromUrl(resolvedUrl);

  if (!mediaId) {
    timings.totalTime = performance.now() - totalStartTime;
    return { status: "invalid_url", timings };
  }

  const cached = postCache.get(mediaId);
  if (cached && cached.expires > Date.now()) {
    timings.totalTime = performance.now() - totalStartTime;
    return { ...cached.result, cached: true, timings };
  }

  const fetchStartTime = performance.now();
  let v1FailureReason = "";

  try {
    const headers = await getRotatedInstagramHeaders();
    const hasSession = Boolean(
      headers["Cookie"] && headers["Cookie"].includes("sessionid"),
    );

    if (hasSession) {
      const apiUrl = `${INSTAGRAM_API_V1}/${mediaId}/info/`;
      const response = await fetch(apiUrl, {
        method: "GET",
        headers,
        redirect: "manual",
      });

      timings.fetchTime = performance.now() - fetchStartTime;

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") || "";
        v1FailureReason = `Instagram redirected v1 API (${response.status} -> ${location || "login/challenge"}). Cookie in insta.txt may be expired or IP-flagged.`;
      } else {
        const processStartTime = performance.now();
        const responseText = await response.text();
        try {
          const jsonResponse = JSON.parse(responseText);
          if (
            jsonResponse.status === "ok" &&
            Array.isArray(jsonResponse.items) &&
            jsonResponse.items.length > 0
          ) {
            const v1Result = buildResultFromV1Item(
              jsonResponse.items[0],
              timings,
            );
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            if (v1Result) {
              postCache.set(mediaId, {
                result: v1Result,
                expires: Date.now() + CACHE_TTL_MS,
              });
              return v1Result;
            }
          }
          v1FailureReason =
            jsonResponse.message || "Media not found in v1 API payload.";
        } catch {
          v1FailureReason = responseText.includes("Login")
            ? "Login required. The cookie in insta.txt is expired or invalid."
            : "Instagram blocked the v1 API request or returned non-JSON.";
        }
      }
    } else {
      v1FailureReason = "Missing valid sessionid cookie in insta.txt";
    }

    if (shortcode) {
      const htmlResult = await fetchFromHtmlFallback(
        shortcode,
        timings,
        totalStartTime,
        fetchStartTime,
      );
      if (htmlResult) {
        postCache.set(mediaId, {
          result: htmlResult,
          expires: Date.now() + CACHE_TTL_MS,
        });
        return htmlResult;
      }

      const gqlResult = await fetchFromGraphqlFallback(
        shortcode,
        timings,
        totalStartTime,
        fetchStartTime,
      );
      if (gqlResult) {
        postCache.set(mediaId, {
          result: gqlResult,
          expires: Date.now() + CACHE_TTL_MS,
        });
        return gqlResult;
      }
    }

    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "blocked",
      error_details:
        v1FailureReason ||
        "Instagram blocked all extraction methods (v1 API, HTML embed, and GraphQL).",
      timings,
    };
  } catch (error) {
    timings.totalTime = performance.now() - totalStartTime;
    return {
      status: "fetch_error",
      error_details:
        error instanceof Error ? error.message : "Scraping failed.",
      timings,
    };
  }
}

export default async function handler(url: string) {
  return await scrapeInstagram(url);
}
