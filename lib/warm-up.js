/**
 * warm-up.js
 * Manages the account warm-up process:
 * 1. Add a cookie → test login → start warm-up
 * 2. Publish 5 videos (from uploads/) with 15-minute pause each
 * 3. After last publish, wait 24 hours
 * 4. Promote to reserve_cookies (warmed pool)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const Publisher = require('./publisher');
const FileModifier = require('./file-modifier');
const { analyzeMedia, compareQueueFiles } = require('./media-intel');
const { getRandomTitle } = require('./random-meta');
const antiDetect = require('./anti-detect');

const WARM_VIDEOS_NEEDED = 5;
const WARM_PAUSE_MS = 15 * 60 * 1000;       // 15 min between videos
const WARM_PROMOTE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h after last video

let baseDir = path.join(__dirname, '..');
if (process.pkg) baseDir = path.dirname(process.execPath);
const UPLOAD_DIR = path.join(baseDir, 'uploads');

// Active warm-up coroutines: { warmId: { running: bool, promise } }
const warmRuntime = {};

function getModifier() {
    if (!getModifier._inst) getModifier._inst = new FileModifier();
    return getModifier._inst;
}

/**
 * Test a cookie by trying to get an API key.
 * Returns { success, accountName, error }
 */
async function testWarmCookie(cookie, proxy = '') {
    try {
        const { httpsAgent, httpAgent } = antiDetect.createHttpAgents(proxy, 'warmup');
        const headers = antiDetect.buildBrowserHeaders({
            accountId: 'warmup',
            cookie,
            origin: config.siteDomain,
            referer: config.siteDomain + '/'
        });
        const resp = await axios.get(`${config.siteDomain}/share`, {
            headers,
            httpsAgent,
            httpAgent,
            proxy: false,
            timeout: config.requestTimeout
        });
        const html = String(resp.data || '');
        if (html.includes('Account suspended')) {
            return { success: false, error: 'Аккаунт заблокирован (Account suspended)' };
        }
        const $ = cheerio.load(html);
        const keyMatch = html.match(/apiKey:\s*['"]([^'"]+)['"]/);
        if (!keyMatch || !keyMatch[1]) {
            return { success: false, error: 'apiKey не найден. Cookie невалидна.' };
        }
        const accountName = $('.FooterTop-Login').text().trim();
        if (!accountName || accountName.toLowerCase() === 'log in') {
            return { success: false, error: 'Cookie устарела (требуется вход)' };
        }
        return { success: true, accountName };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Start warm-up for a specific warm_account id.
 */
async function startWarmUp(warmId) {
    if (warmRuntime[warmId] && warmRuntime[warmId].running) return;
    warmRuntime[warmId] = { running: true };
    warmRuntime[warmId].promise = _runWarmUp(warmId).finally(() => {
        if (warmRuntime[warmId]) warmRuntime[warmId].running = false;
    });
}

/**
 * Stop warm-up for a specific warm_account id.
 */
function stopWarmUp(warmId) {
    if (warmRuntime[warmId]) warmRuntime[warmId].running = false;
}

function isWarmRunning(warmId) {
    return !!(warmRuntime[warmId] && warmRuntime[warmId].running);
}

async function _runWarmUp(warmId) {
    const acc = await db.getWarmAccount(warmId);
    if (!acc) return;

    const pub = new Publisher(`warm_${warmId}`, acc.proxy || '');
    pub.setCookie(acc.cookie);
    const modifier = getModifier();

    logger.info(`🔥 [Прогрев #${warmId}] Запуск прогрева аккаунта: ${acc.account_name || 'неизвестно'}`);

    let videosPublished = acc.videos_published || 0;

    // If already published enough, check if 24h passed
    if (videosPublished >= WARM_VIDEOS_NEEDED) {
        await _checkAndPromote(warmId, acc);
        return;
    }

    while (warmRuntime[warmId] && warmRuntime[warmId].running && videosPublished < WARM_VIDEOS_NEEDED) {
        // Pick a file from uploads/
        const files = await _getUploadsFiles();
        if (!files.length) {
            logger.warn(`🔥 [Прогрев #${warmId}] Нет файлов в очереди для прогрева!`);
            await _sleep(warmId, 60 * 1000); // wait 1 min and retry
            continue;
        }

        const fileInfo = files[videosPublished % files.length];
        const fileName = fileInfo.name;
        const filePath = path.join(UPLOAD_DIR, fileName);

        let modifiedPath = null;
        let success = false;

        for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
            if (!warmRuntime[warmId] || !warmRuntime[warmId].running) break;
            try {
                const durationHint = fileInfo.durationLabel ? ` (${fileInfo.durationLabel})` : '';
                logger.info(`🔥 [Прогрев #${warmId}] Видео ${videosPublished + 1}/${WARM_VIDEOS_NEEDED}${durationHint}: получение ключа...`);
                const apiKey = await pub.getFreshKey();

                if (modifiedPath) modifier.cleanup(modifiedPath);
                modifiedPath = await modifier.modify(filePath, `warm_${warmId}`, null, fileInfo);

                const result = await pub.uploadFile(modifiedPath, apiKey, fileName);
                modifier.cleanup(modifiedPath);
                modifiedPath = null;

                if (!result.id) {
                    if (result.error === 'You already added this file') {
                        // count as success
                        success = true;
                        break;
                    }
                    throw new Error(result.error || 'Нет ID файла');
                }

                await _sleep(warmId, config.sleepBetweenSteps);
                await pub.saveMetadata(
                    result.id,
                    apiKey,
                    { title: getRandomTitle({ durationSec: fileInfo.durationSec }), caption: '' },
                    pub.isVideoFile(fileName)
                );
                await _sleep(warmId, config.sleepBetweenSteps);
                await pub.publish(apiKey);

                success = true;
                logger.success(`🔥 [Прогрев #${warmId}] Видео ${videosPublished + 1}/${WARM_VIDEOS_NEEDED} опубликовано: ${fileName}`);
                break;
            } catch (err) {
                if (modifiedPath) { modifier.cleanup(modifiedPath); modifiedPath = null; }
                logger.error(`🔥 [Прогрев #${warmId}] Ошибка (попытка ${attempt}/${config.maxRetries}): ${err.message}`);

                if (err.message && err.message.toLowerCase().includes('posting too fast')) {
                    logger.warn(`🔥 [Прогрев #${warmId}] Остановка прогрева из-за лимита скорости (posting too fast).`);
                    break;
                }

                if (attempt < config.maxRetries) {
                    await _sleep(warmId, attempt * 5000);
                }
            }
        }

        if (success) {
            videosPublished++;
            const now = new Date().toISOString();
            await db.updateWarmAccount(warmId, {
                videos_published: videosPublished,
                last_published_at: now,
                status: videosPublished >= WARM_VIDEOS_NEEDED ? 'waiting_promote' : 'warming'
            });

            if (videosPublished < WARM_VIDEOS_NEEDED) {
                logger.info(`🔥 [Прогрев #${warmId}] Пауза 15 минут перед следующим видео...`);
                if (!await _sleep(warmId, WARM_PAUSE_MS)) break;
            }
        }
    }

    // After 5 videos published, check promotion
    const refreshed = await db.getWarmAccount(warmId);
    if (refreshed && refreshed.videos_published >= WARM_VIDEOS_NEEDED) {
        await _checkAndPromote(warmId, refreshed);
    }
}

async function _checkAndPromote(warmId, acc) {
    if (!acc.last_published_at) return;

    const lastPublished = new Date(acc.last_published_at).getTime();
    const now = Date.now();
    const msRemaining = WARM_PROMOTE_AFTER_MS - (now - lastPublished);

    if (msRemaining <= 0) {
        // Promote now
        await db.promoteWarmToReserve(warmId);
        logger.success(`🔥 [Прогрев #${warmId}] Аккаунт ${acc.account_name} прогрет и добавлен в резерв!`);
    } else {
        const hoursLeft = Math.ceil(msRemaining / 3600000);
        logger.info(`🔥 [Прогрев #${warmId}] Все 5 видео опубликованы. Осталось ждать ${hoursLeft}ч до добавления в резерв...`);
        await db.updateWarmAccount(warmId, { status: 'waiting_promote' });

        // Schedule promotion check
        setTimeout(async () => {
            const current = await db.getWarmAccount(warmId);
            if (current && current.status === 'waiting_promote') {
                await db.promoteWarmToReserve(warmId);
                logger.success(`🔥 [Прогрев #${warmId}] Аккаунт ${current.account_name} добавлен в резерв (после ожидания)!`);
            }
        }, msRemaining + 5000);
    }
}

async function _getUploadsFiles() {
    if (!fs.existsSync(UPLOAD_DIR)) return [];
    const files = [];
    for (const f of fs.readdirSync(UPLOAD_DIR).filter(name => !name.startsWith('.'))) {
        const filePath = path.join(UPLOAD_DIR, f);
        const s = fs.statSync(filePath);
        const media = await analyzeMedia(filePath, f, s.size);
        files.push({
            name: f,
            size: s.size,
            ...media,
        });
    }
    files.sort(compareQueueFiles);
    return files;
}

async function _sleep(warmId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (!warmRuntime[warmId] || !warmRuntime[warmId].running) return false;
        await new Promise(r => setTimeout(r, 1000));
    }
    return true;
}

/**
 * Resume any warming/waiting_promote accounts on server startup.
 */
async function resumeWarmUps() {
    const all = await db.getWarmAccounts();
    for (const acc of all) {
        if (acc.status === 'warming') {
            logger.info(`🔥 Возобновление прогрева #${acc.id} (${acc.account_name || 'неизвестно'})`);
            startWarmUp(acc.id);
        } else if (acc.status === 'waiting_promote') {
            // Check if 24h already passed
            await _checkAndPromote(acc.id, acc);
        }
    }
}

module.exports = { testWarmCookie, startWarmUp, stopWarmUp, isWarmRunning, resumeWarmUps, WARM_VIDEOS_NEEDED };
