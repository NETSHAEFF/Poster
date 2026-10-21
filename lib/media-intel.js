const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const config = require('./config');

const VIDEO_EXTENSIONS = new Set((config.videoExtensions || []).map(ext => ext.toLowerCase()));
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

let probeStatus = null;

function ensureFfprobe() {
    if (probeStatus !== null) return probeStatus;
    try {
        execSync('ffprobe -version', { stdio: 'ignore', timeout: 3000 });
        probeStatus = true;
    } catch {
        probeStatus = false;
    }
    return probeStatus;
}

function getKind(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    return 'other';
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.round(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getDurationBucket(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
    if (seconds <= 60) return 'short';
    if (seconds <= 600) return 'medium';
    return 'long';
}

function getDurationLabel(seconds) {
    const bucket = getDurationBucket(seconds);
    if (bucket === 'short') return '<=60s';
    if (bucket === 'medium') return '1-10m';
    if (bucket === 'long') return '10m+';
    return '';
}

function scoreMediaFile({ kind, durationSec, sizeBytes }) {
    const sizeMb = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes / 1048576 : 0;

    if (kind === 'video') {
        if (Number.isFinite(durationSec) && durationSec > 0) {
            if (durationSec <= 60) {
                return 1000000 - Math.round(durationSec * 1000) - Math.round(sizeMb * 10);
            }
            if (durationSec <= 600) {
                return 700000 - Math.round(durationSec * 100) - Math.round(sizeMb * 5);
            }
            return 100000 - Math.round(durationSec * 10) - Math.round(sizeMb * 2);
        }
        return 500000 - Math.round(sizeMb * 5);
    }

    if (kind === 'image') {
        return 850000 - Math.round(sizeMb * 10);
    }

    return 300000 - Math.round(sizeMb * 5);
}

function compareQueueFiles(a, b) {
    const scoreDiff = (b.priorityScore || 0) - (a.priorityScore || 0);
    if (scoreDiff !== 0) return scoreDiff;

    const durA = Number.isFinite(a.durationSec) ? a.durationSec : Number.POSITIVE_INFINITY;
    const durB = Number.isFinite(b.durationSec) ? b.durationSec : Number.POSITIVE_INFINITY;
    if (durA !== durB) return durA - durB;

    return String(a.name || '').localeCompare(String(b.name || ''));
}

function probeDuration(filePath, timeoutMs = 5000) {
    if (!ensureFfprobe()) return Promise.resolve(null);

    return new Promise(resolve => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(null);
        }, timeoutMs);

        ffmpeg.ffprobe(filePath, (err, data) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (err) return resolve(null);
            const duration = Number(data && data.format && data.format.duration);
            resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
        });
    });
}

async function analyzeMedia(filePath, fileName = path.basename(filePath), sizeBytes = null) {
    let resolvedSize = sizeBytes;
    if (!Number.isFinite(resolvedSize)) {
        try {
            resolvedSize = fs.statSync(filePath).size;
        } catch {
            resolvedSize = 0;
        }
    }

    const kind = getKind(fileName);
    const durationSec = kind === 'video' ? await probeDuration(filePath) : null;
    const durationLabel = getDurationLabel(durationSec);
    const priorityScore = scoreMediaFile({ kind, durationSec, sizeBytes: resolvedSize });

    return {
        kind,
        durationSec,
        durationLabel,
        priorityScore,
    };
}

module.exports = {
    analyzeMedia,
    compareQueueFiles,
    formatDuration,
    getDurationBucket,
    getDurationLabel,
    getKind,
    scoreMediaFile,
};
