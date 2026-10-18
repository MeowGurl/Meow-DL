import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const INSTAGRAM_GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
const INSTAGRAM_STORIES_URL = 'https://i.instagram.com/api/v1/feed/user/';
const COOKIE_FILE_PATH = join(process.cwd(), 'api', 'insta.txt');

const BASE_INSTAGRAM_HEADERS: Record<string, string> = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
    'X-CSRFToken': 'Gs50xX-0t-hz_2bezC1yWj',
    'X-IG-App-ID': '1217981644879628',
    'X-FB-LSD': 'AVqbxe3J_YA',
    'X-ASBD-ID': '129477',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
};

const STATIC_REQUEST_PARAMS = {
    av: '0',
    __d: 'www',
    __user: '0',
    __a: '1',
    __req: '3',
    __hs: '19624.HYP:instagram_web_pkg.2.1..0.0',
    dpr: '3',
    __ccg: 'UNKNOWN',
    __rev: '1008824440',
    __s: 'xf44ne:zhh75g:xr51e7',
    __hsi: '7282217488877343271',
    __dyn: '7xeUmwlEnwn8K2WnFw9-2i5U4e0yoW3q32360CEbo1nEhw2nVE4W0om78b87C0yE5ufz81s8hwGwQwoEcE7O2l0Fwqo31w9a9x-0z8-U2zxe2GewGwso88cobEaU2eUlwhEe87q7-0iK2S3qazo7u1xwIw8O321LwTwKG1pg661pwr86C1mwraCg',
    __csr: 'gZ3yFmJkillQvV6ybimnG8AmhqujGbLADgjyEOWz49z9XDlAXBJpC7Wy-vQTSvUGWGh5u8KibG44dBiigrgjDxGjU0150Q0848azk48N09C02IR0go4SaR70r8owyg9pU0V23hwiA0LQczA48S0f-x-27o05NG0fkw',
    __comet_req: '7',
    lsd: 'AVqbxe3J_YA',
    jazoest: '2957',
    __spin_r: '1008824440',
    __spin_b: 'trunk',
    __spin_t: '1695523385',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
    server_timestamps: 'true',
    doc_id: '10015901848480474',
};

const STATIC_REQUEST_BODY_PART = new URLSearchParams(STATIC_REQUEST_PARAMS).toString();
const SHORTCODE_REGEX = /(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/;
const PROFILE_REGEX = /instagram\.com\/([a-zA-Z0-9_.]+)(?:\/)?$/;

type CleanedMedia = {
    type: 'video' | 'photo';
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
    username: string;
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

type LocationInfo = {
    name?: string;
    slug?: string;
};

export type ExtractionResult = {
    status: 'success' | 'not_found' | 'fetch_error' | 'invalid_url';
    author?: string;
    owner?: OwnerInfo;
    title?: string;
    thumbnail?: string;
    media?: CleanedMedia[];
    likeCount?: number;
    commentCount?: number;
    viewCount?: number;
    timestamp?: number;
    hashtags?: string[];
    mentions?: string[];
    music?: MusicInfo;
    location?: LocationInfo;
    comments?: Comment[];
    cached?: boolean;
    timings: {
        fetchTime: number;
        processTime: number;
        totalTime: number;
    };
};

const postCache = new Map<string, { result: ExtractionResult; expires: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

let cookieLinesCache: string[] = [];
let cookieCacheExpires = 0;
let cookieRoundRobinIndex = 0;

async function getRotatedInstagramHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...BASE_INSTAGRAM_HEADERS };

    if (Date.now() > cookieCacheExpires) {
        try {
            const rawFile = await readFile(COOKIE_FILE_PATH, 'utf-8');
            cookieLinesCache = rawFile
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#'));
            cookieCacheExpires = Date.now() + 60 * 1000;
        } catch {
            cookieLinesCache = [];
        }
    }

    if (cookieLinesCache.length > 0) {
        const selectedCookie = cookieLinesCache[cookieRoundRobinIndex % cookieLinesCache.length];
        cookieRoundRobinIndex++;

        headers['Cookie'] = selectedCookie;
        const csrfMatch = selectedCookie.match(/csrftoken=([^;\s]+)/);
        if (csrfMatch?.[1]) {
            headers['X-CSRFToken'] = csrfMatch[1];
        }
    }

    return headers;
}

async function resolveRedirectUrl(url: string): Promise<string> {
    if (!url.includes('/share/')) {
        return url;
    }

    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
            },
        });
        return res.url || url;
    } catch {
        return url;
    }
}

function getPostShortcode(url: string): string | null {
    const match = url.match(SHORTCODE_REGEX);
    return match ? match[1] : null;
}

function getProfileUsername(url: string): string | null {
    const match = url.match(PROFILE_REGEX);
    return match && match[1] !== 'p' && match[1] !== 'reel' && match[1] !== 'reels' ? match[1] : null;
}

function generateRequestBody(shortcode: string, userId = '0'): string {
    const variables = {
        shortcode,
        fetch_comment_count: 40,
        fetch_related_profile_media_count: 3,
        parent_comment_count: 24,
        child_comment_count: 3,
        fetch_like_count: 10,
        fetch_tagged_user_count: null,
        fetch_preview_comment_count: 2,
        has_threaded_comments: true,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
    };

    const params = new URLSearchParams(STATIC_REQUEST_BODY_PART);
    if (userId && userId !== '0') {
        params.set('av', userId);
        params.set('__user', userId);
    }
    params.set('variables', JSON.stringify(variables));

    return params.toString();
}

function extractMediaFromResponse(mediaData: any): CleanedMedia[] {
    if (!mediaData) return [];

    const carouselEdges = mediaData.edge_sidecar_to_children?.edges;
    if (carouselEdges) {
        return carouselEdges.flatMap((edge: any) => extractMediaFromResponse(edge.node));
    }

    if (mediaData.is_video) {
        return mediaData.video_url ? [{
            type: 'video',
            url: mediaData.video_url,
            thumbnail: mediaData.display_url,
            width: mediaData.dimensions?.width,
            height: mediaData.dimensions?.height,
            duration: mediaData.video_duration,
        }] : [];
    }

    const highestQualityImageSrc = mediaData.display_resources?.at(-1)?.src;
    const displayUrl = mediaData.display_url;
    const finalImageUrl = highestQualityImageSrc || displayUrl;

    return finalImageUrl ? [{
        type: 'photo',
        url: finalImageUrl,
        thumbnail: finalImageUrl,
        width: mediaData.dimensions?.width,
        height: mediaData.dimensions?.height,
    }] : [];
}

function parseHashtagsAndMentions(text: string): { hashtags: string[]; mentions: string[] } {
    if (!text) return { hashtags: [], mentions: [] };
    const hashtags = Array.from(text.matchAll(/#([a-zA-Z0-9_]+)/g)).map((m) => m[1]);
    const mentions = Array.from(text.matchAll(/@([a-zA-Z0-9_.]+)/g)).map((m) => m[1]);
    return { hashtags, mentions };
}

export async function scrapeInstagram(rawUrl: string): Promise<ExtractionResult> {
    const timings = { fetchTime: 0, processTime: 0, totalTime: 0 };
    const totalStartTime = performance.now();

    const resolvedUrl = await resolveRedirectUrl(rawUrl);
    const shortcode = getPostShortcode(resolvedUrl);

    if (!shortcode) {
        timings.totalTime = performance.now() - totalStartTime;
        return {
            status: 'invalid_url',
            timings,
        };
    }

    const cached = postCache.get(shortcode);
    if (cached && cached.expires > Date.now()) {
        timings.totalTime = performance.now() - totalStartTime;
        return {
            ...cached.result,
            cached: true,
            timings,
        };
    }

    try {
        const fetchStartTime = performance.now();
        const headers = await getRotatedInstagramHeaders();
        const userIdMatch = headers['Cookie']?.match(/ds_user_id=([^;\s]+)/);
        const userId = userIdMatch?.[1] || '0';

        const response = await fetch(INSTAGRAM_GRAPHQL_URL, {
            method: 'POST',
            headers,
            body: generateRequestBody(shortcode, userId),
        });
        timings.fetchTime = performance.now() - fetchStartTime;

        if (!response.ok) {
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'fetch_error',
                timings,
            };
        }

        const processStartTime = performance.now();
        const jsonResponse = await response.json() as any;
        const mediaData = jsonResponse.data?.xdt_shortcode_media;

        if (!mediaData) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'not_found',
                timings,
            };
        }

        const mediaUrls = extractMediaFromResponse(mediaData);
        if (mediaUrls.length === 0) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'not_found',
                timings,
            };
        }

        const ownerObj: OwnerInfo = {
            username: mediaData.owner?.username,
            fullName: mediaData.owner?.full_name,
            profilePicUrl: mediaData.owner?.profile_pic_url,
            isVerified: mediaData.owner?.is_verified,
            followersCount: mediaData.owner?.edge_followed_by?.count,
        };

        const captionText = mediaData.edge_media_to_caption?.edges[0]?.node?.text || '';
        const { hashtags, mentions } = parseHashtagsAndMentions(captionText);

        let musicInfo: MusicInfo | undefined = undefined;
        const clipsAttr = mediaData.clips_music_attribution_info;
        if (clipsAttr) {
            musicInfo = {
                title: clipsAttr.song_name,
                artist: clipsAttr.artist_name,
                audioUrl: clipsAttr.audio_drop_in_url || clipsAttr.progressive_download_url,
                isOriginal: clipsAttr.uses_original_audio,
            };
        }

        let locInfo: LocationInfo | undefined = undefined;
        if (mediaData.location) {
            locInfo = {
                name: mediaData.location.name,
                slug: mediaData.location.slug,
            };
        }

        const comments: Comment[] = (mediaData.edge_media_to_parent_comment?.edges || [])
            .slice(0, 10)
            .map((edge: any) => ({
                text: edge.node.text,
                author: edge.node.owner.username,
                timestamp: edge.node.created_at,
            }))
            .filter((c: Comment) => c.text);

        timings.processTime = performance.now() - processStartTime;
        timings.totalTime = performance.now() - totalStartTime;

        const result: ExtractionResult = {
            status: 'success',
            author: ownerObj.fullName || ownerObj.username,
            owner: ownerObj,
            title: captionText,
            thumbnail: mediaData.display_url,
            media: mediaUrls,
            likeCount: mediaData.edge_media_preview_like?.count,
            commentCount: mediaData.edge_media_to_parent_comment?.count,
            viewCount: mediaData.video_play_count || mediaData.video_view_count,
            timestamp: mediaData.taken_at_timestamp,
            hashtags,
            mentions,
            music: musicInfo,
            location: locInfo,
            comments,
            cached: false,
            timings,
        };

        postCache.set(shortcode, { result, expires: Date.now() + CACHE_TTL_MS });
        return result;
    } catch (error) {
        console.error('Instagram Scraper Error:', error);
        timings.totalTime = performance.now() - totalStartTime;
        return {
            status: 'fetch_error',
            timings,
        };
    }
}

export default async function handler(url: string) {
    return await scrapeInstagram(url);
}
