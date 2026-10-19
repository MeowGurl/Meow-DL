import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const INSTAGRAM_API_V1 = 'https://www.instagram.com/api/v1/media';
const COOKIE_FILE_PATH = join(process.cwd(), 'api', 'insta.txt');

const BASE_HEADERS: Record<string, string> = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '359341',
    'X-IG-WWW-Claim': '0',
    'Origin': 'https://www.instagram.com',
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
    const headers: Record<string, string> = { ...BASE_HEADERS };

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
            headers: { 'User-Agent': BASE_HEADERS['User-Agent'] },
        });
        return res.url || url;
    } catch {
        return url;
    }
}

function shortcodeToMediaId(shortcode: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (let i = 0; i < shortcode.length; i++) {
        id = (id * 64n) + BigInt(alphabet.indexOf(shortcode[i]));
    }
    return id.toString();
}

function getPostShortcode(url: string): string | null {
    const match = url.match(SHORTCODE_REGEX);
    if (!match) return null;
    let shortcode = match[1];
    if (shortcode.length > 28) {
        shortcode = shortcode.substring(0, shortcode.length - 28);
    }
    return shortcode;
}

function extractMediaFromV1Item(item: any): CleanedMedia[] {
    const mediaList: CleanedMedia[] = [];

    if (item.carousel_media) {
        for (const carouselItem of item.carousel_media) {
            mediaList.push(...extractMediaFromV1Item(carouselItem));
        }
        return mediaList;
    }

    const isVideo = item.media_type === 2 || !!item.video_versions;
    
    let bestImage = item.image_versions2?.candidates?.[0]?.url;
    let width = item.original_width || item.image_versions2?.candidates?.[0]?.width;
    let height = item.original_height || item.image_versions2?.candidates?.[0]?.height;

    if (isVideo && item.video_versions?.length > 0) {
        const bestVideo = item.video_versions[0];
        mediaList.push({
            type: 'video',
            url: bestVideo.url,
            thumbnail: bestImage,
            width: bestVideo.width || width,
            height: bestVideo.height || height,
            duration: item.video_duration,
        });
    } else if (bestImage) {
        mediaList.push({
            type: 'photo',
            url: bestImage,
            thumbnail: bestImage,
            width,
            height,
        });
    }

    return mediaList;
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
        const mediaId = shortcodeToMediaId(shortcode);
        const apiUrl = `${INSTAGRAM_API_V1}/${mediaId}/info/`;

        const fetchStartTime = performance.now();
        const headers = await getRotatedInstagramHeaders();

        if (!headers['Cookie'] || !headers['Cookie'].includes('sessionid')) {
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'blocked',
                error_details: 'API requires a valid sessionid cookie in insta.txt',
                timings
            };
        }

        const response = await fetch(apiUrl, {
            method: 'GET',
            headers,
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
            
            return {
                status: 'blocked',
                error_details: responseText.includes('Login') 
                    ? 'Login required. The cookie provided in insta.txt is expired or invalid.' 
                    : 'Instagram blocked the request or returned non-JSON.',
                timings
            };
        }

        if (jsonResponse.status !== 'ok' || !jsonResponse.items || jsonResponse.items.length === 0) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'not_found',
                error_details: jsonResponse.message || 'Media not found in API payload.',
                timings,
            };
        }

        const item = jsonResponse.items[0];
        const mediaUrls = extractMediaFromV1Item(item);

        if (mediaUrls.length === 0) {
            timings.processTime = performance.now() - processStartTime;
            timings.totalTime = performance.now() - totalStartTime;
            return {
                status: 'not_found',
                error_details: 'No downloadable media mapped from payload.',
                timings,
            };
        }

        const ownerObj: OwnerInfo = {
            username: item.user?.username,
            fullName: item.user?.full_name,
            profilePicUrl: item.user?.profile_pic_url,
            isVerified: item.user?.is_verified,
            followersCount: item.user?.follower_count,
        };

        const captionText = item.caption?.text || '';

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

        const comments: Comment[] = (item.preview_comments || []).map((c: any) => ({
            text: c.text,
            author: c.user?.username,
            timestamp: c.created_at,
        }));

        timings.processTime = performance.now() - processStartTime;
        timings.totalTime = performance.now() - totalStartTime;

        const result: ExtractionResult = {
            status: 'success',
            author: ownerObj.fullName || ownerObj.username,
            owner: ownerObj,
            title: captionText,
            thumbnail: mediaUrls[0]?.thumbnail,
            media: mediaUrls,
            likeCount: item.like_count,
            commentCount: item.comment_count,
            viewCount: item.play_count || item.view_count,
            timestamp: item.taken_at,
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
