import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const INSTAGRAM_GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
const COOKIE_FILE_PATH = join(process.cwd(), 'api', 'insta.txt');

const BASE_INSTAGRAM_HEADERS: Record<string, string> = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-IG-App-ID': '936619743392459',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const SHORTCODE_REGEX = /(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/;

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

export type ExtractionResult = {
    status: 'success' | 'not_found' | 'fetch_error' | 'invalid_url' | 'blocked';
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
    hashtags?: string[];
    mentions?: string[];
    music?: MusicInfo;
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
    if (!url.includes('/share/')) return url;

    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: {
                'User-Agent': BASE_INSTAGRAM_HEADERS['User-Agent'],
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

function generateRequestBody(shortcode: string): string {
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

    const params = new URLSearchParams();
    params.set('doc_id', '10015901848480474');
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
    const finalImageUrl = highestQualityImageSrc || mediaData.display_url;

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
        return { status: 'invalid_url', timings };
    }

    const cached = postCache.get(shortcode);
    if (cached && cached.expires > Date.now()) {
        timings.totalTime = performance.now() - totalStartTime;
        return { ...cached.result, cached: true, timings };
    }

    try {
        const fetchStartTime = performance.now();
        const headers = await getRotatedInstagramHeaders();

        const response = await fetch(INSTAGRAM_GRAPHQL_URL, {
            method: 'POST',
            headers,
            body: generateRequestBody(shortcode),
        });
        timings.fetchTime = performance.now() - fetchStartTime;

        const processStartTime = performance.now();
        const responseText = await response.text();

        let jsonResponse: any;
        try {
            jsonResponse = JSON.parse(responseText);
        } catch (e) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            
            let blockReason = 'Instagram returned a non-JSON response.';
            if (responseText.includes('Login • Instagram')) {
                blockReason = 'Login required. Cookie is expired or missing.';
            } else if (responseText.includes('challenge')) {
                blockReason = 'Account checkpoint/challenge triggered by Render IP.';
            }

            return {
                status: 'blocked',
                error_details: blockReason,
                timings
            };
        }

        const mediaData = jsonResponse.data?.xdt_shortcode_media;

        if (!mediaData) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'not_found',
                error_details: 'The media was not found, or the account is private.',
                timings,
            };
        }

        const mediaUrls = extractMediaFromResponse(mediaData);
        if (mediaUrls.length === 0) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'not_found',
                error_details: 'No downloadable media found in the payload.',
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
            comments,
            cached: false,
            timings,
        };

        postCache.set(shortcode, { result, expires: Date.now() + CACHE_TTL_MS });
        return result;
    } catch (error) {
        timings.totalTime = performance.now() - totalStartTime;
        return {
            status: 'fetch_error',
            error_details: error instanceof Error ? error.message : String(error),
            timings,
        };
    }
}

export default async function handler(url: string) {
    return await scrapeInstagram(url);
}
