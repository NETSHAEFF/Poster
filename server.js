const config = require('./lib/config');
const logger = require('./lib/logger');
const Publisher = require('./lib/publisher');
const FileModifier = require('./lib/file-modifier');
const { getRandomTitle, getRandomCaption, makeVariedTitle, makeVariedCaption, parseSpintax } = require('./lib/random-meta');
const { sendTelegramAlert } = require('./lib/telegram');
const db = require('./lib/db');
const { generateAccountName } = require('./lib/ai-generator');
const { shortenUrl, cloakAllUrls } = require('./lib/url-shortener');
const { resumeWarmUps } = require('./lib/warm-up');
const { analyzeMedia, compareQueueFiles } = require('./lib/media-intel');
const autocopy = require('./lib/autocopy');
const downloader = require('./lib/downloader');
const antiDetect = require('./lib/anti-detect');
const torManager = require('./lib/tor-manager');

function isNetworkOrProxyError(err) {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    const code = (err.code || '').toUpperCase();
    return (
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH' ||
        msg.includes('socket closed') ||
        msg.includes('proxy connection timed out') ||
        msg.includes('socks') ||
        msg.includes('timeout of') ||
        msg.includes('network error') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504')
    );
}

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const modifier = new FileModifier();

// --- Directories ---
let baseDir = __dirname;
if (process.pkg) baseDir = path.dirname(process.execPath);

const UPLOAD_DIR = path.join(baseDir, 'uploads');
const DATA_DIR = path.join(baseDir, 'data');
const ENV_FILE = path.join(baseDir, '.env');
const MAX_ACCOUNTS = 5;

[UPLOAD_DIR, DATA_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// --- Multer ---
const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        let name = Buffer.from(file.originalname, 'latin1').toString('utf8');
        let target = path.join(UPLOAD_DIR, name);
        let counter = 1;
        while (fs.existsSync(target)) {
            const ext = path.extname(name);
            const base = path.basename(name, ext);
            name = `${base}_${counter}${ext}`;
            target = path.join(UPLOAD_DIR, name);
            counter++;
        }
        cb(null, name);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: config.maxFileSize },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(config.allowedExtensions.includes(ext) ? null : new Error(`Формат ${ext} не поддерживается`), true);
    }
});

// --- Middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Accounts ---
let accounts = [];

function createDefaultAccount(id, cookie = '', proxy = '') {
    return {
        id,
        name: `Аккаунт ${id}`,
        cookie,
        proxy,
        delayMinutes: config.defaultDelay,
    };
}

function migrateFromSingleAccount() {
    const oldCookie = process.env.MY_COOKIE || '';
    return [{
        id: 1,
        name: 'Аккаунт 1',
        cookie: oldCookie,
        proxy: '',
        delayMinutes: config.defaultDelay,
    }];
}

// --- Runtime state per account ---
const runtime = {};
const linkCache = { input: '', output: '' };
const currentlyProcessingFiles = new Set();

function initAccountRuntime(acc) {
    const pub = new Publisher(acc.id, acc.proxy || '');
    pub.setCookie(acc.cookie);
    runtime[acc.id] = {
        publisher: pub,
        isRunning: false,
        currentAction: 'Ожидание команды...',
        stats: { views: 0, subs: 0 },
        queueCache: null,
    };
}

// --- Async Helpers ---
async function saveAccounts() {
    for (const acc of accounts) {
        await db.saveAccount(acc);
    }
}

function clearQueueCache(accountId) {
    if (accountId && runtime[accountId]) {
        runtime[accountId].queueCache = null;
    } else {
        Object.values(runtime).forEach(r => r.queueCache = null);
    }
}

function removeFileFromAllQueueCaches(fileName) {
    Object.values(runtime).forEach(r => {
        if (r && r.queueCache) {
            r.queueCache = r.queueCache.filter(f => f.name !== fileName);
            if (r.queueCache.length === 0) {
                r.queueCache = null;
            }
        }
    });
}

function removeFileFromQueueCache(accountId, fileName) {
    removeFileFromAllQueueCaches(fileName);
}

function normalizeMetaText(text, fallback = '', maxLen = 48, preserveNewlines = false) {
    let raw = String(text || fallback || '');
    if (preserveNewlines) {
        // Preserve line breaks, collapse spaces per line, remove redundant empty lines
        raw = raw
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    } else {
        raw = raw.replace(/\s+/g, ' ').trim();
    }
    if (!raw) return '';
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen).trim();
}

function addInvisibleJitter(text) {
    if (!text || typeof text !== 'string') return text || '';
    // Вставляем невидимый символ (Zero-width space) в случайное место строки
    // Визуально текст идентичен на 100%, но хэши (MD5/SHA) и фильтры точного совпадения спама обходятся
    const zwsp = '\u200B';
    const pos = Math.floor(Math.random() * (text.length + 1));
    return text.slice(0, pos) + zwsp + text.slice(pos);
}

async function getShortLink(link) {
    const raw = String(link || '').trim();
    if (!raw) return '';
    if (linkCache.input === raw && linkCache.output) return linkCache.output;
    const shortLink = await shortenUrl(raw);
    linkCache.input = raw;
    linkCache.output = String(shortLink || raw).trim();
    return linkCache.output;
}

async function buildFileMeta(fileName, fileInfo, globalMeta) {
    const rawTgLink = String(globalMeta.tgLink || '').trim();
    const shortLink = rawTgLink ? await getShortLink(rawTgLink) : '';

    if (globalMeta.randomMode) {
        const rawTitle = getRandomTitle({ durationSec: fileInfo?.durationSec });
        const rawCaption = getRandomCaption(shortLink, { durationSec: fileInfo?.durationSec });
        const cloakedCaption = await cloakAllUrls(rawCaption);
        return {
            title: makeVariedTitle(rawTitle, 48),
            caption: makeVariedCaption(cloakedCaption),
        };
    }

    // 1. Заголовок: Spintax + анти-спам вариации (гомоглифы + декораторы)
    const baseTitle = globalMeta.title ? globalMeta.title : path.parse(fileName).name;
    const title = makeVariedTitle(baseTitle, 48);

    // 2. Описание: обработка переносов строк и ссылки
    let baseCaption = normalizeMetaText(globalMeta.caption, '', 220, true);

    if (shortLink) {
        if (!baseCaption) {
            baseCaption = `More verified content:\n${shortLink}`;
        } else if (baseCaption.includes('{link}')) {
            baseCaption = baseCaption.replace(/\{link\}/g, shortLink);
        } else if (!baseCaption.includes(shortLink)) {
            baseCaption = `${baseCaption}\n\n${shortLink}`.trim();
        }
    }

    // 3. Универсальное клоакирование любых ссылок в описании (включая t.me, https://) с чередованием провайдеров
    let caption = await cloakAllUrls(baseCaption);

    // 4. Применение Spintax, гомоглифов и микро-джиттера к описанию
    caption = makeVariedCaption(caption);

    return {
        title,
        caption,
    };
}

async function getQueueFiles(accountId) {
    const rt = runtime[accountId];
    if (rt && rt.queueCache && rt.queueCache.length > 0) return rt.queueCache;
    if (!fs.existsSync(UPLOAD_DIR)) return [];
    
    const processed = await db.getProcessedFileNames(accountId);
    
    const files = [];
    for (const f of fs.readdirSync(UPLOAD_DIR).filter(name => !name.startsWith('.') && !processed.has(name))) {
        const filePath = path.join(UPLOAD_DIR, f);
        try {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) continue;
            const ext = path.extname(f).toLowerCase();
            if (!config.allowedExtensions.includes(ext)) continue;

            const media = await analyzeMedia(filePath, f, stat.size);
            files.push({
                name: f,
                size: stat.size,
                ...media,
            });
        } catch (e) {
            continue;
        }
    }
    files.sort(compareQueueFiles);
    if (rt) rt.queueCache = files;
    return files;
}

async function getAccountState(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    const rt = runtime[accountId];
    if (!acc || !rt) return null;
    const files = await getQueueFiles(accountId);
    const history = await db.getHistory(accountId);
    return {
        id: acc.id,
        name: acc.name,
        isRunning: rt.isRunning,
        currentAction: rt.currentAction,
        delayMinutes: acc.delayMinutes,
        hasCookie: !!acc.cookie,
        cookiePreview: acc.cookie ? acc.cookie.substring(0, 40) + '...' : '',
        proxy: acc.proxy || '',
        proxyPreview: acc.proxy ? acc.proxy.replace(/:\/\/.*@/, '://***@') : '',
        isProxyBanned: false,
        browserProfile: antiDetect.getBrowserProfile(acc.id).id,
        metadata: acc.metadata,
        stats: rt.stats,
        queueCount: files.length,
        files: files.slice(0, 50),
        history: history,
    };
}

async function getFullState() {
    const [stateAccounts, reserveCount, globalMeta, torStats] = await Promise.all([
        Promise.all(accounts.map(a => getAccountState(a.id))),
        db.getReserveCookiesCount(),
        db.getGlobalMetadata(),
        torManager.getStats(accounts)
    ]);
    return {
        accounts: stateAccounts,
        reserveCookiesCount: reserveCount,
        proxyStats: torStats,
        torStats,
        autocopyTasks: autocopy.getTasks(),
        downloaderState: downloader.getState(),
        globalMetadata: globalMeta
    };
}

async function setAction(accountId, action) {
    if (runtime[accountId]) {
        runtime[accountId].currentAction = action;
    }
    // Use debounced broadcast (logger handles deduplication)
    logger.broadcastState(await getFullState());
}

async function interruptibleSleep(accountId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (!runtime[accountId] || !runtime[accountId].isRunning) return false;
        await new Promise(r => setTimeout(r, 1000));
    }
    return true;
}

// --- Publishing Loop (per account) ---
async function startPublishingLoop(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    const rt = runtime[accountId];
    if (!acc || !rt) return;

    logger.info(`▶️ [${acc.name}] Цикл публикации запущен`);
    clearQueueCache(accountId);

    // Гарантируем работу через Tor: если прокси не задан или не Tor — назначаем изолированный Tor-маршрут
    if (!acc.proxy || !acc.proxy.includes('127.0.0.1')) {
        const torProxy = torManager.getProxyForAccount(acc.id);
        acc.proxy = torProxy;
        await db.saveAccount(acc);
        rt.publisher.setProxy(torProxy);
        logger.info(`🧅 [${acc.name}] Назначен Tor-маршрут: ${torProxy}`);
        logger.broadcastState(await getFullState());
    }

    try {
        while (rt.isRunning) {
            let files = await getQueueFiles(accountId);
            const availableFiles = files.filter(f => !currentlyProcessingFiles.has(f.name));

            if (!availableFiles.length) {
                if (files.length > 0) {
                    await setAction(accountId, '⏳ Ожидание (файлы обрабатываются другим аккаунтом)...');
                    if (!await interruptibleSleep(accountId, 10000)) break;
                    continue;
                }
                await setAction(accountId, 'Все доступные файлы опубликованы');
                rt.isRunning = false;
                logger.info(`📭 [${acc.name}] Очередь пуста (все файлы опубликованы), остановка`);
                break;
            }

            const fileInfo = availableFiles[0];
            const fileName = fileInfo.name;
            const filePath = path.join(UPLOAD_DIR, fileName);
            const isVideo = rt.publisher.isVideoFile(fileName);
            let success = false;
            let modifiedPath = null;

            // Lock file in memory to prevent concurrent upload by another account
            currentlyProcessingFiles.add(fileName);

            try {
                for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
                    if (!rt.isRunning) break;
                    try {
                        await setAction(accountId, '🔑 Получение API ключа...');
                        const apiKey = await rt.publisher.getFreshKey();
                        logger.success(`[${acc.name}] API ключ получен`);

                        const globalMeta = await db.getGlobalMetadata();
                        await setAction(accountId, `🔄 Модификация: ${fileName}`);
                        logger.info(`[${acc.name}] Модификация метаданных: ${fileName}`);
                        if (modifiedPath) modifier.cleanup(modifiedPath);
                        modifiedPath = await modifier.modify(filePath, accountId, globalMeta.watermark, fileInfo);
                        logger.success(`[${acc.name}] Файл модифицирован`);

                        const fileMeta = await buildFileMeta(fileName, fileInfo, globalMeta);
                        logger.info(`[${acc.name}] Метаданные: "${fileMeta.title}" / "${fileMeta.caption}"`);

                        const durationHint = fileInfo.durationLabel ? ` · ${fileInfo.durationLabel}` : '';
                        await setAction(accountId, `📤 Загрузка: ${fileMeta.title || fileName}${durationHint} (${attempt}/${config.maxRetries})`);
                        logger.info(`[${acc.name}] Загрузка: ${fileName}`);
                        const result = await rt.publisher.uploadFile(modifiedPath, apiKey, fileName);

                        modifier.cleanup(modifiedPath);
                        modifiedPath = null;

                        if (!result.id) {
                            if (result.error === "You already added this file") {
                                logger.warn(`[${acc.name}] Дубликат: ${fileName}`);
                                await db.addHistory(accountId, { fileName, status: 'duplicate' });
                                removeFileFromAllQueueCaches(fileName);
                                success = true;
                                break;
                            }
                            throw new Error(result.error || 'Нет ID файла');
                        }

                        if (!await interruptibleSleep(accountId, antiDetect.jitter(config.sleepBetweenSteps, 30))) break;

                        await setAction(accountId, `📝 Метаданные: ${fileName}`);
                        await rt.publisher.saveMetadata(result.id, apiKey, fileMeta, isVideo);
                        logger.info(`[${acc.name}] Метаданные сохранены`);

                        if (!await interruptibleSleep(accountId, antiDetect.jitter(config.sleepBetweenSteps, 30))) break;

                        await setAction(accountId, `🚀 Публикация: ${fileName}`);
                        await rt.publisher.publish(apiKey);

                        logger.success(`✅ [${acc.name}] Опубликовано: ${fileName}`);
                        await db.addHistory(accountId, { fileName, status: 'success', fileId: result.id });
                        removeFileFromAllQueueCaches(fileName);
                        success = true;
                        break;

                    } catch (err) {
                        if (modifiedPath) { modifier.cleanup(modifiedPath); modifiedPath = null; }
                        logger.error(`❌ [${acc.name}] Ошибка ${fileName} (${attempt}/${config.maxRetries}): ${err.message}`);

                        // Critical security check: modification error (ffmpeg error, timeout, un-modified file protection)
                        const isModError = err.message && (
                            err.message.includes('ffmpeg') ||
                            err.message.includes('Таймаут обработки видео') ||
                            err.message.includes('недоступен для обработки видео') ||
                            err.message.includes('Исходный файл не')
                        );
                        if (isModError) {
                            logger.error(`🛡️ [${acc.name}] Файл ${fileName} пропущен: ошибка уникализации (${err.message}). Исходный файл НЕ отправлен во избежание бана.`);
                            await db.addHistory(accountId, { fileName, status: 'error', error: `Ошибка уникализации: ${err.message}` });
                            removeFileFromAllQueueCaches(fileName);
                            break; // Do not retry broken/timeout video, proceed safely to next file
                        }

                        // Проверка на ошибку сети / Tor (таймаут, сброс соединения, отказ узла, 502/503/504)
                        if (isNetworkOrProxyError(err)) {
                            logger.warn(`⚠️ [${acc.name}] Сбой соединения (${err.message}). Выполняем ротацию Tor-маршрута...`);
                            await setAction(accountId, '🔄 Ротация Tor-маршрута...');
                            try {
                                const newProxy = torManager.rotateCircuit(acc.id);
                                acc.proxy = newProxy;
                                await db.saveAccount(acc);
                                rt.publisher.setProxy(newProxy);
                                logger.broadcastState(await getFullState());
                                logger.success(`[${acc.name}] 🧅 Сформирован новый Tor-маршрут: ${newProxy}. Повторяем шаг...`);
                                attempt = Math.max(0, attempt - 1);
                                if (!await interruptibleSleep(accountId, 2000)) break;
                                continue;
                            } catch (rotErr) {
                                logger.error(`❌ [${acc.name}] Не удалось ротировать Tor: ${rotErr.message}`);
                            }
                        }

                        if (err.message && err.message.includes('Account suspended')) {
                            const accName = rt.publisher.accountName || acc.name;
                            
                            // Ротируем Tor-маршрут для получения свежего IP
                            const newProxy = torManager.rotateCircuit(acc.id);
                            acc.proxy = newProxy;
                            await db.saveAccount(acc);
                            rt.publisher.setProxy(newProxy);
                            logger.success(`[${acc.name}] 🧅 Для нового аккаунта сформирован свежий Tor IP: ${newProxy}`);

                            const newCookie = await db.popReserveCookie();
                            const remainCount = await db.getReserveCookiesCount();

                            if (newCookie) {
                                // Generate new account name via Gemini AI
                                const newName = await generateAccountName();
                                const globalMeta = await db.getGlobalMetadata();
                                const linkToSend = globalMeta.tgLink || '';

                                await sendTelegramAlert(`🚨 Внимание! Аккаунт заблокирован!\n👤 Заблокирован: ${accName}\n🔄 Заменён на: ${newName}\n🌐 Новый Tor-маршрут: ${newProxy}\n🔗 Ссылка: ${linkToSend || 'без ссылки'}\n🍪 Осталось запасных куки: ${remainCount}\nВремя: ${new Date().toLocaleString('ru-RU')}`);
                                logger.warn(`[${acc.name}] 🔄 Применяем резервную Cookie и новый Tor IP...`);
                                acc.cookie = newCookie;
                                acc.name = newName;
                                acc.proxy = newProxy;
                                rt.publisher.setCookie(newCookie);
                                rt.publisher.setProxy(newProxy);
                                rt.publisher.accountName = null;
                                rt.publisher.uid = null;
                                rt.stats = { views: 0, subs: 0 };
                                await db.saveAccount(acc);
                                logger.success(`[${acc.name}] ✅ Аккаунт заменён: новое имя "${newName}", прокси: ${newProxy || 'нет'}`);
                                
                                attempt--; // Retry this attempt with the new account
                                await setAction(accountId, `🔄 Автозамена аккаунта и прокси...`);
                                if (!await interruptibleSleep(accountId, 5000)) break;
                                continue;
                            } else {
                                await sendTelegramAlert(`🚨 КРИТИЧЕСКАЯ ОШИБКА!\n👤 Аккаунт: ${accName} заблокирован!\n🚫 Прокси ${acc.proxy || 'нет'} отправлен в ЧС.\n🛑 РАБОТА ПОЛНОСТЬЮ ОСТАНОВЛЕНА, НЕТ ЗАПАСНЫХ КУКИ!\nВремя: ${new Date().toLocaleString('ru-RU')}`);
                                rt.isRunning = false;
                                logger.error(`[${acc.name}] ❌ Резервных Cookie нет. Остановка из-за блокировки!`);
                                break;
                            }
                        }

                        if (err.message && err.message.toLowerCase().includes('posting too fast')) {
                            rt.isRunning = false;
                            await setAction(accountId, `🛑 Остановлено: лимит скорости (posting too fast)`);
                            logger.warn(`🛑 [${acc.name}] Постинг остановлен из-за ограничения: You are posting too fast. Try again later.`);
                            await sendTelegramAlert(`⚠️ [${acc.name}] Постинг остановлен!\nЛимит: You are posting too fast. Try again later.\nВремя: ${new Date().toLocaleString('ru-RU')}`);
                            break;
                        }

                        if (attempt < config.maxRetries) {
                            const delay = attempt * 5000;
                            await setAction(accountId, `⏳ Повтор через ${delay / 1000}с...`);
                            if (!await interruptibleSleep(accountId, delay)) break;
                        }
                    }
                }

                if (!success && rt.isRunning) {
                    logger.error(`⛔ [${acc.name}] Пропуск: ${fileName}`);
                    await db.addHistory(accountId, { fileName, status: 'error', error: 'Все попытки исчерпаны' });
                    removeFileFromAllQueueCaches(fileName);
                }
            } finally {
                currentlyProcessingFiles.delete(fileName);
            }

            if (!rt.isRunning) break;
            logger.broadcastState(await getFullState());
            const pauseMs = antiDetect.jitter(acc.delayMinutes * 60 * 1000, 20);
            const pauseMin = (pauseMs / 60000).toFixed(1);
            await setAction(accountId, `⏳ Пауза ~${pauseMin} мин...`);
            logger.info(`[${acc.name}] Пауза ${pauseMin} мин (с джиттером)`);
            if (!await interruptibleSleep(accountId, pauseMs)) break;
        }
    } catch (err) {
        logger.error(`💥 [${acc.name}] Критическая ошибка: ${err.message}`);
        await setAction(accountId, `❌ ${err.message}`);
    }
    rt.isRunning = false;
    logger.broadcastState(await getFullState());
    logger.info(`⏹️ [${acc.name}] Цикл остановлен`);
}

// --- Stats loop (per account) ---
async function updateStats(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    const rt = runtime[accountId];
    if (!acc || !rt || !acc.cookie) return;
    const stats = await rt.publisher.getStats();
    let updated = false;

    if (stats && (stats.views > 0 || stats.subs > 0)) {
        rt.stats = stats;
        updated = true;
    }

    if (rt.publisher.accountName && rt.publisher.accountName !== 'Неизвестно' && acc.name !== rt.publisher.accountName) {
        acc.name = rt.publisher.accountName;
        await db.saveAccount(acc);
        updated = true;
    }

    if (updated) {
        logger.broadcastState(await getFullState());
    }
}

async function updateAllStats() {
    for (const acc of accounts) {
        await updateStats(acc.id);
    }
}

// --- App Initialization ---
async function startApp() {
    await db.init();
    await torManager.init();
    accounts = await db.getAccounts();
    if (accounts.length === 0) {
        accounts = migrateFromSingleAccount();
        for (const acc of accounts) await db.saveAccount(acc);
    }
    accounts.forEach(acc => initAccountRuntime(acc));

    // Назначаем каждому аккаунту изолированный Tor-маршрут (Circuit)
    for (const acc of accounts) {
        if (!acc.proxy || !acc.proxy.includes('127.0.0.1')) {
            const torProxy = torManager.getProxyForAccount(acc.id);
            acc.proxy = torProxy;
            await db.saveAccount(acc);
            if (runtime[acc.id] && runtime[acc.id].publisher) {
                runtime[acc.id].publisher.setProxy(torProxy);
            }
        }
    }
    logger.info(`🧅 Все аккаунты подключены к сети Tor (порт ${torManager.port || 9150})`);

    // Загрузчик по умолчанию использует прямое подключение (высокая скорость, без таймаутов).
    // Если пользователь явно сохранил прокси для загрузчика в настройках, загружаем его.
    const savedDlProxy = await db.getDownloaderProxy();
    if (downloader.setProxy) {
        downloader.setProxy(savedDlProxy || '');
        if (savedDlProxy) {
            logger.info(`📥 Загрузчик: настроен прокси ${savedDlProxy}`);
        } else {
            logger.info('📥 Загрузчик: используется прямое подключение (без прокси)');
        }
    }

    setInterval(updateAllStats, 5 * 60 * 1000);
    setTimeout(updateAllStats, 2000);

    const setupApi = require('./lib/api');
    setupApi(app, {
        accounts, runtime, logger, upload,
        UPLOAD_DIR, ENV_FILE, MAX_ACCOUNTS, db,
        getFullState, getAccountState, updateStats,
        startPublishingLoop, clearQueueCache, setAction,
        saveAccounts, createDefaultAccount, initAccountRuntime,
        downloader, modifier, torManager
    });

    // Resume any warm-up processes from previous session
    resumeWarmUps();

    app.use((err, req, res, next) => {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Файл слишком большой' });
        if (err.message) return res.status(400).json({ error: err.message });
        next(err);
    });

    function shutdown(sig) {
        logger.info(`${sig} — завершение...`);
        Object.values(runtime).forEach(rt => rt.isRunning = false);
        modifier.cleanupAll();
        setTimeout(() => process.exit(0), 3000);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    app.listen(config.port, () => logger.info(`🚀 Панель: http://localhost:${config.port}`));
}

startApp().catch(err => {
    console.error("Startup error:", err);
    process.exit(1);
});
