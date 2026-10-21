const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let baseDir = path.join(__dirname, '..');
if (process.pkg) baseDir = path.dirname(process.execPath);

const UPLOAD_DIR = path.join(baseDir, 'uploads');
const DW_DOWNLOADS_DIR = path.join(baseDir, 'DwFromNv', 'downloads');

[UPLOAD_DIR, DW_DOWNLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
});

const BASE_URL = 'https://namevids.me';
const antiDetect = require('./anti-detect');
const USER_AGENT = antiDetect.BROWSER_PROFILES[0].userAgent;

let customProxy = '';

function setProxy(proxy) {
    customProxy = String(proxy || '').trim();
}

function getProxy() {
    return customProxy;
}

function getDownloaderAgents() {
    return antiDetect.createHttpAgents(customProxy, 'downloader');
}

function formatDownloaderError(err) {
    if (!err) return 'Неизвестная ошибка';
    const msg = err.message || String(err);
    if (customProxy && (
        msg.includes('Proxy connection timed out') ||
        msg.includes('Socket closed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED')
    )) {
        return `Ошибка прокси (${customProxy}): ${msg}. Переключите загрузчик на прямое подключение.`;
    }
    return msg;
}

const DEFAULT_HEADERS = {
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${BASE_URL}/`
};

function sanitizeFilename(name, maxLength = 60) {
    if (!name) return 'video';
    let clean = name.replace(/[\\/*?:"<>|]/g, '');
    clean = clean.replace(/\s+/g, ' ').trim();
    if (!clean) clean = 'video';
    return clean.substring(0, maxLength).replace(/[. ]+$/, '');
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const totalSec = Math.floor(Number(seconds));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

async function resolveVideoId(urlOrId) {
    if (!urlOrId) throw new Error('Не указан URL или ID видео');
    const str = String(urlOrId).trim();
    if (/^\d+$/.test(str)) {
        return parseInt(str, 10);
    }
    const fullUrl = str.startsWith('http') ? str : `${BASE_URL}/${str.replace(/^\//, '')}`;
    const { httpsAgent, httpAgent } = getDownloaderAgents();
    let res;
    try {
        res = await axios.get(fullUrl, {
            headers: DEFAULT_HEADERS,
            httpsAgent,
            httpAgent,
            proxy: false,
            timeout: 15000
        });
    } catch (e) {
        throw new Error(formatDownloaderError(e));
    }
    const html = res.data;
    const fidMatch = html.match(/fileid\s*=\s*(\d+);/);
    if (fidMatch) return parseInt(fidMatch[1], 10);

    const didMatch = html.match(/data-id=["'](\d+)["']/);
    if (didMatch) return parseInt(didMatch[1], 10);

    throw new Error(`Не удалось найти ID видео на странице: ${urlOrId}`);
}

async function getStreamUrl(videoId) {
    const viewUrl = `${BASE_URL}/api/get_view.php?fid=${videoId}`;
    const postData = 'message=1';
    const { httpsAgent, httpAgent } = getDownloaderAgents();
    let res;
    try {
        res = await axios.post(viewUrl, postData, {
            headers: {
                ...DEFAULT_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            httpsAgent,
            httpAgent,
            proxy: false,
            timeout: 15000
        });
    } catch (e) {
        throw new Error(formatDownloaderError(e));
    }

    const param = res.data?.param;
    if (!param || !param.streamToken || !param.uv) {
        throw new Error('Не удалось получить токен потока или адреса CDN');
    }

    const decoded = Buffer.from(param.uv, 'base64').toString('utf8');
    const servers = JSON.parse(decoded);
    const host = servers.m || servers.d || servers.f;
    if (!host) {
        throw new Error('В ответе API отсутствуют активные серверы CDN');
    }

    return `${host}/s/${param.streamToken}`;
}

const pageCursorCache = new Map();

function clearCursorCache(category) {
    if (category) {
        for (const key of pageCursorCache.keys()) {
            if (key.startsWith(`${category}:`)) pageCursorCache.delete(key);
        }
    } else {
        pageCursorCache.clear();
    }
}

async function fetchVideos({
    category = 'top',
    maxCount = 20,
    minViews = 0,
    minDuration = 0,
    maxDuration = 0,
    page = 1,
    depth = 1
} = {}) {
    maxCount = Math.min(Math.max(parseInt(maxCount, 10) || 20, 1), 200);
    minViews = parseInt(minViews, 10) || 0;
    minDuration = parseInt(minDuration, 10) || 0;
    maxDuration = parseInt(maxDuration, 10) || 0;
    page = Math.max(parseInt(page, 10) || 1, 1);
    depth = Math.min(Math.max(parseInt(depth, 10) || 1, 1), 20);

    // Initial cursor for page 1 is always null
    pageCursorCache.set(`${category}:1`, null);

    // Find closest cached page <= target page
    let startPage = 1;
    let cursor = null;
    for (let p = page; p >= 1; p--) {
        const key = `${category}:${p}`;
        if (pageCursorCache.has(key)) {
            startPage = p;
            cursor = pageCursorCache.get(key);
            break;
        }
    }

    // Advance cursor from startPage up to page
    let hasMore = true;
    for (let p = startPage; p < page; p++) {
        let apiUrl = `${BASE_URL}/api/fetch_content.php?categories=${encodeURIComponent(category)}`;
        if (cursor) {
            apiUrl += `&cursor=${encodeURIComponent(JSON.stringify(cursor))}`;
        }
        const { httpsAgent, httpAgent } = getDownloaderAgents();
        let resp;
        try {
            resp = await axios.get(apiUrl, {
                headers: DEFAULT_HEADERS,
                httpsAgent,
                httpAgent,
                proxy: false,
                timeout: 15000
            });
        } catch (e) {
            throw new Error(formatDownloaderError(e));
        }

        const data = resp.data || {};
        if (data.n) {
            pageCursorCache.set(`${category}:${p + 1}`, data.n);
            cursor = data.n;
        }
        if (!data.h || !data.n) {
            hasMore = false;
            break;
        }
    }

    const videos = [];
    if (!hasMore && page > 1) {
        const emptyRes = [];
        emptyRes.videos = [];
        emptyRes.page = page;
        emptyRes.depth = depth;
        emptyRes.pagesScanned = 0;
        emptyRes.hasMore = false;
        return emptyRes;
    }

    let pagesScanned = 0;
    let currentPage = page;

    while (videos.length < maxCount && pagesScanned < depth) {
        let apiUrl = `${BASE_URL}/api/fetch_content.php?categories=${encodeURIComponent(category)}`;
        if (cursor) {
            apiUrl += `&cursor=${encodeURIComponent(JSON.stringify(cursor))}`;
        }

        const { httpsAgent, httpAgent } = getDownloaderAgents();
        let resp;
        try {
            resp = await axios.get(apiUrl, {
                headers: DEFAULT_HEADERS,
                httpsAgent,
                httpAgent,
                proxy: false,
                timeout: 15000
            });
        } catch (e) {
            throw new Error(formatDownloaderError(e));
        }

        pagesScanned++;
        const data = resp.data || {};
        let items = data.i || [];
        if (!items.length && data.g) {
            for (const grp of data.g) {
                if (grp.posts) items.push(...grp.posts);
            }
        }

        if (data.n) {
            pageCursorCache.set(`${category}:${currentPage + 1}`, data.n);
        }

        if (!items || !items.length) {
            hasMore = false;
            break;
        }

        for (const item of items) {
            if (!Array.isArray(item) || item.length < 9) continue;
            const itemType = item[0];
            if (itemType !== 1) continue; // 1 = видео

            const vidId = item[1];
            const vidHash = item[2];
            const userId = item[3];
            const duration = parseInt(item[4] || 0, 10);
            const views = parseInt(item[6] || 0, 10);
            const title = String(item[8] || '').trim() || `Video_${vidId}`;

            if (minViews > 0 && views < minViews) continue;
            if (minDuration > 0 && duration < minDuration) continue;
            if (maxDuration > 0 && duration > maxDuration) continue;

            const safeTitle = sanitizeFilename(title);
            const existsInUploads = fs.existsSync(path.join(UPLOAD_DIR, `${vidId}_${safeTitle}.mp4`)) ||
                                    fs.existsSync(path.join(UPLOAD_DIR, `${vidId}.mp4`));
            const existsInDw = fs.existsSync(path.join(DW_DOWNLOADS_DIR, `${vidId}_${safeTitle}.mp4`)) ||
                               fs.existsSync(path.join(DW_DOWNLOADS_DIR, `${vidId}.mp4`));

            videos.push({
                id: vidId,
                hash: vidHash,
                userId: userId,
                duration: duration,
                durationFormatted: formatDuration(duration),
                views: views,
                title: title,
                safeTitle: safeTitle,
                pageUrl: `${BASE_URL}/${vidHash}`,
                alreadyDownloaded: existsInUploads || existsInDw,
                savedInUploads: existsInUploads,
                savedInDw: existsInDw,
                sourcePage: currentPage
            });

            if (videos.length >= maxCount) break;
        }

        if (!data.h || !data.n) {
            hasMore = false;
            break;
        }
        cursor = data.n;
        currentPage++;
    }

    videos.videos = videos;
    videos.page = page;
    videos.depth = depth;
    videos.pagesScanned = pagesScanned;
    videos.hasMore = hasMore;
    return videos;
}

// Download state and queue
let downloadQueue = [];
let isDownloading = false;
let currentTask = null;
let currentAbortController = null;
let downloadProgress = {
    pct: 0,
    downloadedMb: '0.0',
    totalMb: '0.0',
    speedMb: '0.0',
    statusText: 'Ожидание'
};

function getTasks() {
    return downloadQueue.map(t => ({
        id: t.id,
        videoId: t.videoId,
        title: t.title,
        duration: t.duration,
        durationFormatted: formatDuration(t.duration),
        views: t.views,
        destination: t.destination,
        targetDir: t.targetDir,
        status: t.status, // 'pending' | 'downloading' | 'completed' | 'error' | 'cancelled'
        error: t.error,
        filename: t.filename
    }));
}

function getState() {
    return {
        isDownloading,
        proxy: customProxy || '',
        currentTask: currentTask ? {
            id: currentTask.id,
            videoId: currentTask.videoId,
            title: currentTask.title,
            destination: currentTask.destination,
            filename: currentTask.filename
        } : null,
        progress: downloadProgress,
        queue: getTasks(),
        downloadsCount: getLocalFiles('downloads').length,
        uploadsCount: getLocalFiles('uploads').length
    };
}

function getLocalFiles(dest = 'downloads') {
    const targetDir = dest === 'uploads' ? UPLOAD_DIR : DW_DOWNLOADS_DIR;
    if (!fs.existsSync(targetDir)) return [];
    try {
        const files = fs.readdirSync(targetDir);
        return files
            .filter(f => f.toLowerCase().endsWith('.mp4'))
            .map(f => {
                const fullPath = path.join(targetDir, f);
                const stats = fs.statSync(fullPath);
                return {
                    name: f,
                    sizeBytes: stats.size,
                    sizeMb: (stats.size / (1024 * 1024)).toFixed(2),
                    modifiedAt: stats.mtime
                };
            })
            .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    } catch (e) {
        return [];
    }
}

function openFolder(dest = 'downloads') {
    const targetDir = dest === 'uploads' ? UPLOAD_DIR : DW_DOWNLOADS_DIR;
    if (process.platform === 'win32') {
        exec(`explorer "${targetDir}"`);
    } else if (process.platform === 'darwin') {
        exec(`open "${targetDir}"`);
    } else {
        exec(`xdg-open "${targetDir}"`);
    }
}

function clearFolder(dest = 'downloads') {
    const targetDir = dest === 'uploads' ? UPLOAD_DIR : DW_DOWNLOADS_DIR;
    if (!fs.existsSync(targetDir)) return 0;
    let deletedCount = 0;
    try {
        const files = fs.readdirSync(targetDir);
        for (const file of files) {
            const fullPath = path.join(targetDir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                    fs.unlinkSync(fullPath);
                    deletedCount++;
                }
            } catch (e) {}
        }
    } catch (e) {}
    return deletedCount;
}

function deleteFile(dest = 'downloads', fileName) {
    if (!fileName) return false;
    const targetDir = dest === 'uploads' ? UPLOAD_DIR : DW_DOWNLOADS_DIR;
    const safeName = path.basename(fileName);
    const fullPath = path.join(targetDir, safeName);
    if (fs.existsSync(fullPath)) {
        try {
            fs.unlinkSync(fullPath);
            return true;
        } catch (e) {
            return false;
        }
    }
    return false;
}

function addTasks(items, destination = 'uploads', onUpdate) {
    const targetDir = destination === 'uploads' ? UPLOAD_DIR : DW_DOWNLOADS_DIR;
    const added = [];

    for (const item of items) {
        const id = 'task_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const task = {
            id,
            videoId: item.id,
            title: item.title || `Video_${item.id}`,
            duration: item.duration || 0,
            views: item.views || 0,
            destination,
            targetDir,
            status: 'pending',
            error: null,
            filename: `${item.id}_${sanitizeFilename(item.title || '')}.mp4`
        };
        downloadQueue.push(task);
        added.push(task);
    }

    triggerQueue(onUpdate);
    return added;
}

function triggerQueue(onUpdate) {
    if (isDownloading) return;
    isDownloading = true;
    _runQueue(onUpdate).finally(() => {
        isDownloading = false;
        currentTask = null;
        downloadProgress = {
            pct: 0,
            downloadedMb: '0.0',
            totalMb: '0.0',
            speedMb: '0.0',
            statusText: 'Завершено'
        };
        if (typeof onUpdate === 'function') onUpdate();
    });
}

async function _runQueue(onUpdate) {
    while (true) {
        const nextTask = downloadQueue.find(t => t.status === 'pending');
        if (!nextTask) break;

        currentTask = nextTask;
        nextTask.status = 'downloading';
        downloadProgress = {
            pct: 0,
            downloadedMb: '0.0',
            totalMb: '0.0',
            speedMb: '0.0',
            statusText: `Скачивание: ${nextTask.title}`
        };
        if (typeof onUpdate === 'function') onUpdate();

        try {
            await _downloadSingleTask(nextTask, onUpdate);
            nextTask.status = 'completed';
        } catch (err) {
            if (err.name === 'CanceledError' || err.message === 'canceled') {
                nextTask.status = 'cancelled';
                nextTask.error = 'Отменено пользователем';
            } else {
                nextTask.status = 'error';
                nextTask.error = formatDownloaderError(err);
            }
        }

        if (typeof onUpdate === 'function') onUpdate();
    }
}

async function _downloadSingleTask(task, onUpdate) {
    const targetFile = path.join(task.targetDir, task.filename);
    const partFile = targetFile + '.part';

    // Check if already downloaded
    if (fs.existsSync(targetFile)) {
        downloadProgress.pct = 100;
        downloadProgress.statusText = 'Файл уже существует, пропуск';
        return;
    }

    const streamUrl = await getStreamUrl(task.videoId);

    currentAbortController = new AbortController();
    const { httpsAgent, httpAgent } = getDownloaderAgents();
    let response;
    try {
        response = await axios({
            method: 'GET',
            url: streamUrl,
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': `${BASE_URL}/`
            },
            httpsAgent,
            httpAgent,
            proxy: false,
            responseType: 'stream',
            signal: currentAbortController.signal,
            timeout: 600000 // 10 минут вместо 30 секунд
        });
    } catch (e) {
        throw new Error(formatDownloaderError(e));
    }

    const totalSize = parseInt(response.headers['content-length'] || 0, 10);
    let downloaded = 0;
    const startTime = Date.now();
    let lastUpdate = 0;

    const writer = fs.createWriteStream(partFile);

    return new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
            downloaded += chunk.length;
            const now = Date.now();

            if (now - lastUpdate > 300 || downloaded === totalSize) {
                lastUpdate = now;
                const elapsedSec = Math.max((now - startTime) / 1000, 0.001);
                const speed = (downloaded / (1024 * 1024)) / elapsedSec;
                const pct = totalSize > 0 ? Math.min(Math.round((downloaded / totalSize) * 100), 100) : 0;

                downloadProgress = {
                    pct,
                    downloadedMb: (downloaded / (1024 * 1024)).toFixed(1),
                    totalMb: totalSize > 0 ? (totalSize / (1024 * 1024)).toFixed(1) : '?',
                    speedMb: speed.toFixed(1),
                    statusText: `Скачивание (${pct}%): ${task.title}`
                };

                if (typeof onUpdate === 'function') onUpdate();
            }
        });

        response.data.on('error', err => {
            writer.destroy();
            try { if (fs.existsSync(partFile)) fs.unlinkSync(partFile); } catch (e) {}
            reject(err);
        });

        writer.on('error', err => {
            try { if (fs.existsSync(partFile)) fs.unlinkSync(partFile); } catch (e) {}
            reject(err);
        });

        writer.on('finish', () => {
            try {
                if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
                fs.renameSync(partFile, targetFile);
                downloadProgress.pct = 100;
                resolve();
            } catch (err) {
                reject(err);
            }
        });

        response.data.pipe(writer);
    });
}

function stopDownload(onUpdate) {
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch (e) {}
    }
    for (const t of downloadQueue) {
        if (t.status === 'pending' || t.status === 'downloading') {
            t.status = 'cancelled';
            t.error = 'Остановлено пользователем';
        }
    }
    isDownloading = false;
    currentTask = null;
    downloadProgress = {
        pct: 0,
        downloadedMb: '0.0',
        totalMb: '0.0',
        speedMb: '0.0',
        statusText: 'Остановлено'
    };
    if (typeof onUpdate === 'function') onUpdate();
}

function clearFinishedTasks(onUpdate) {
    downloadQueue = downloadQueue.filter(t => t.status === 'pending' || t.status === 'downloading');
    if (typeof onUpdate === 'function') onUpdate();
}

module.exports = {
    fetchVideos,
    clearCursorCache,
    resolveVideoId,
    getStreamUrl,
    addTasks,
    stopDownload,
    clearFinishedTasks,
    getState,
    getLocalFiles,
    openFolder,
    clearFolder,
    deleteFile,
    setProxy,
    getProxy,
    UPLOAD_DIR,
    DW_DOWNLOADS_DIR
};
