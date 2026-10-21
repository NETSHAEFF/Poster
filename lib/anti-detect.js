/**
 * anti-detect.js
 * Комплексный модуль защиты от детекта и банов:
 * - Ротация и эмуляция реальных браузеров (Chrome, Edge, Firefox актуальных версий)
 * - Согласованные Client Hints (sec-ch-ua, sec-ch-ua-platform, etc.)
 * - Настройка TLS ciphers (маскировка JA3 отпечатка Node.js под реальный браузер)
 * - Поддержка HTTP / HTTPS / SOCKS5 прокси per-account
 * - Человекоподобный джиттер задержек
 * - Браузерный WebKit multipart boundary
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Наборы реальных современных шифров браузеров (TLS 1.3 и TLS 1.2)
const TLS13_CIPHERS = [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256'
];

const TLS12_CIPHERS = [
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'AES128-SHA',
    'AES256-SHA'
];

// Алгоритмы подписи (Signature Algorithms), идентичные Chromium 120-135
const BROWSER_SIGALGS = [
    'ecdsa_secp256r1_sha256',
    'rsa_pss_rsae_sha256',
    'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384',
    'rsa_pss_rsae_sha384',
    'rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha512',
    'rsa_pkcs1_sha512'
].join(':');

/**
 * Генерирует уникальный, но детерминированный для аккаунта набор шифров.
 * Каждый аккаунт получает свой индивидуальный TLS / JA3 / JA4 отпечаток перед сервером.
 */
function getUniqueCiphers(accountId = 'default') {
    const seed = String(accountId || 'default');
    const hash = crypto.createHash('sha256').update(seed).digest();
    
    // Перемешиваем TLS 1.2 шифры псевдослучайно на основе хэша аккаунта
    const shuffledTls12 = [...TLS12_CIPHERS];
    for (let i = shuffledTls12.length - 1; i > 0; i--) {
        const j = hash[i % hash.length] % (i + 1);
        [shuffledTls12[i], shuffledTls12[j]] = [shuffledTls12[j], shuffledTls12[i]];
    }
    
    // TLS 1.3 идут первыми, затем перемешанные TLS 1.2
    return [...TLS13_CIPHERS, ...shuffledTls12].join(':');
}

const BROWSER_CIPHERS = [...TLS13_CIPHERS, ...TLS12_CIPHERS].join(':');

// Профили реальных современных браузеров
const BROWSER_PROFILES = [
    {
        id: 'chrome-win-133',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        clientHints: {
            'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-ch-ua-platform-version': '"15.0.0"'
        },
        acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    {
        id: 'chrome-win-132',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        clientHints: {
            'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-ch-ua-platform-version': '"10.0.0"'
        },
        acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.8'
    },
    {
        id: 'edge-win-133',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0',
        clientHints: {
            'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="133", "Microsoft Edge";v="133"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-ch-ua-platform-version': '"15.0.0"'
        },
        acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    {
        id: 'chrome-mac-133',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        clientHints: {
            'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-ch-ua-platform-version': '"14.4.1"'
        },
        acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    {
        id: 'firefox-win-135',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
        clientHints: {}, // Firefox не отправляет sec-ch-ua
        acceptLanguage: 'ru-RU,ru;q=0.8,en-US;q=0.5,en;q=0.3'
    }
];

// Кэш профилей для стабильности каждого аккаунта
const accountProfiles = new Map();

/**
 * Получить или зафиксировать профиль браузера для конкретного аккаунта
 */
function getBrowserProfile(accountId) {
    const key = String(accountId || 'default');
    if (!accountProfiles.has(key)) {
        // Хэшируем ID, чтобы аккаунт всегда получал один и тот же профиль
        const hash = crypto.createHash('md5').update(key).digest('hex');
        const index = parseInt(hash.substring(0, 4), 16) % BROWSER_PROFILES.length;
        accountProfiles.set(key, BROWSER_PROFILES[index]);
    }
    return accountProfiles.get(key);
}

/**
 * Создаёт HTTPS / HTTP агент с поддержкой браузерных TLS-шифров и прокси.
 * accountId используется для детерминированной уникализации TLS / JA3 / JA4 ciphers.
 */
function createHttpAgents(proxyUrl = '', accountId = 'default') {
    const trimmedProxy = (proxyUrl || '').trim();
    const ciphers = getUniqueCiphers(accountId);
    const tlsOptions = {
        ciphers,
        sigalgs: BROWSER_SIGALGS,
        ecdhCurve: 'X25519:P-256:P-384',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        honorCipherOrder: true,
        keepAlive: true,
        keepAliveMsecs: 10000
    };

    if (trimmedProxy) {
        try {
            if (trimmedProxy.startsWith('socks4://') || trimmedProxy.startsWith('socks5://') || trimmedProxy.startsWith('socks5h://') || trimmedProxy.startsWith('socks://')) {
                const socksAgent = new SocksProxyAgent(trimmedProxy, tlsOptions);
                return { httpsAgent: socksAgent, httpAgent: socksAgent };
            } else {
                const httpsAgent = new HttpsProxyAgent(trimmedProxy, tlsOptions);
                return { httpsAgent, httpAgent: httpsAgent };
            }
        } catch (e) {
            console.error(`[anti-detect] Ошибка создания прокси-агента для "${trimmedProxy}":`, e.message);
        }
    }

    // Без прокси: используем TLS-агент с уникальными шифрами браузера
    const defaultHttpsAgent = new https.Agent(tlsOptions);
    const defaultHttpAgent = new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 10000
    });

    return { httpsAgent: defaultHttpsAgent, httpAgent: defaultHttpAgent };
}

/**
 * Генерирует полный набор браузерных заголовков
 * Автоматически рассчитывает Sec-Fetch-Site (cross-site / same-origin)
 * и изолирует Cookie при запросах к сторонним API доменам (oakroot.top и др.)
 */
function buildBrowserHeaders({
    accountId,
    cookie,
    origin,
    referer,
    targetUrl = null,
    secFetchSite = null,
    isAjax = false,
    contentType = null,
    includeCookie = null
}) {
    const profile = getBrowserProfile(accountId);

    // Определяем отношение целевого URL к Origin
    let fetchSite = secFetchSite;
    let isCrossSite = false;

    if (!fetchSite) {
        if (targetUrl && origin) {
            try {
                const targetOrigin = new URL(targetUrl).origin.toLowerCase();
                const sourceOrigin = new URL(origin).origin.toLowerCase();
                isCrossSite = targetOrigin !== sourceOrigin;
                fetchSite = isCrossSite ? 'cross-site' : 'same-origin';
            } catch (e) {
                fetchSite = 'cross-site';
                isCrossSite = true;
            }
        } else {
            fetchSite = 'same-origin';
        }
    } else {
        isCrossSite = fetchSite === 'cross-site';
    }

    const headers = {
        'User-Agent': profile.userAgent,
        'Accept': isAjax
            ? 'application/json, text/plain, */*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': profile.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': isAjax ? 'empty' : 'document',
        'Sec-Fetch-Mode': isAjax ? 'cors' : 'navigate',
        'Sec-Fetch-Site': fetchSite,
        ...profile.clientHints
    };

    if (!isAjax) {
        headers['Upgrade-Insecure-Requests'] = '1';
        headers['Sec-Fetch-User'] = '?1';
    }

    // В реальном браузере cookies отправляются ТОЛЬКО на свой домен (same-origin).
    // На сторонние домены (oakroot.top) куки namevids.me никогда не отправляются!
    const shouldSendCookie = includeCookie !== null
        ? !!includeCookie
        : (!isCrossSite && !!cookie);

    if (shouldSendCookie && cookie) {
        headers['Cookie'] = cookie;
    }

    if (origin) headers['Origin'] = origin;
    if (referer) headers['Referer'] = referer;
    if (contentType) headers['Content-Type'] = contentType;

    return headers;
}

/**
 * Создаёт подлинный WebKit multipart boundary (16 буквенно-цифровых символов как в Chromium)
 */
function generateWebKitBoundary() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let boundary = '----WebKitFormBoundary';
    for (let i = 0; i < 16; i++) {
        boundary += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return boundary;
}

/**
 * Добавляет случайный джиттер к базовой паузе
 * Например: jitter(3000, 25) вернет от 2250 до 3750 мс
 */
function jitter(baseMs, variancePercent = 25) {
    const fraction = variancePercent / 100;
    const min = Math.max(0, baseMs * (1 - fraction));
    const max = baseMs * (1 + fraction);
    return Math.floor(min + Math.random() * (max - min));
}

/**
 * Генерирует естественное мобильное/камерное имя файла для аплоада
 * Скрывает любые NameVids ID, сторонние префиксы и названия файлов
 */
function generateNaturalFilename(originalName) {
    const ext = path.extname(originalName || '.mp4').toLowerCase() || '.mp4';
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const rnd = crypto.randomBytes(4).toString('hex');
    const templates = [
        `VID_${dateStr}_${timeStr}${ext}`,
        `VID_${dateStr}_${rnd}${ext}`,
        `video_${dateStr}_${rnd}${ext}`,
        `MOV_${dateStr}_${timeStr}${ext}`,
        `PXL_${dateStr}_${timeStr}${ext}`
    ];
    return templates[Math.floor(Math.random() * templates.length)];
}

module.exports = {
    BROWSER_CIPHERS,
    BROWSER_SIGALGS,
    BROWSER_PROFILES,
    getUniqueCiphers,
    getBrowserProfile,
    createHttpAgents,
    buildBrowserHeaders,
    generateWebKitBoundary,
    jitter,
    generateNaturalFilename
};
