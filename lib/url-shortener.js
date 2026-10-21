const axios = require('axios');

/**
 * Нормализует URL перед сокращением:
 * - Убирает пробелы
 * - Исправляет https://t.me/@name -> https://t.me/name
 * - Добавляет протокол https:// при необходимости
 */
function normalizeUrl(url) {
    if (!url) return '';
    let clean = String(url).trim();
    // Очищаем от случайных запятых/точек/скобок на конце ссылки
    clean = clean.replace(/[.,;!?)]+$/, '');
    clean = clean.replace(/^(https?:\/\/)?t\.me\/@+/i, 'https://t.me/');
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
        clean = 'https://' + clean;
    }
    return clean;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const PROVIDERS = [
    {
        name: 'clck.ru',
        shorten: async (cleanUrl) => {
            const resp = await axios.get('https://clck.ru/--', {
                params: { url: cleanUrl },
                headers: { 'User-Agent': BROWSER_UA },
                timeout: 5000
            });
            if (resp.data && String(resp.data).startsWith('http')) {
                return String(resp.data).trim();
            }
            throw new Error('clck.ru invalid response');
        }
    },
    {
        name: 'da.gd',
        shorten: async (cleanUrl) => {
            const resp = await axios.get('https://da.gd/s', {
                params: { url: cleanUrl },
                headers: { 'User-Agent': BROWSER_UA },
                timeout: 5000
            });
            if (resp.data && String(resp.data).startsWith('http')) {
                return String(resp.data).trim();
            }
            throw new Error('da.gd invalid response');
        }
    },
    {
        name: 'ulvis.net',
        shorten: async (cleanUrl) => {
            const resp = await axios.get('https://ulvis.net/api.php', {
                params: { url: cleanUrl },
                headers: { 'User-Agent': BROWSER_UA },
                timeout: 5000
            });
            if (resp.data && String(resp.data).startsWith('http')) {
                return String(resp.data).trim();
            }
            throw new Error('ulvis.net invalid response');
        }
    },
    {
        name: 'tinyurl.com',
        shorten: async (cleanUrl) => {
            // TinyURL блокирует прямой t.me с 400 Bad Request
            if (cleanUrl.includes('t.me') || cleanUrl.includes('telegram.me')) {
                throw new Error('tinyurl blocks telegram');
            }
            const resp = await axios.get('https://tinyurl.com/api-create.php', {
                params: { url: cleanUrl },
                headers: { 'User-Agent': BROWSER_UA },
                timeout: 5000
            });
            if (resp.data && String(resp.data).startsWith('http')) {
                return String(resp.data).trim();
            }
            throw new Error('tinyurl invalid response');
        }
    }
];

/**
 * Сокращает URL через каскад надёжных сервисов с поддержкой ротации провайдеров
 */
async function shortenUrl(originalUrl, options = {}) {
    const clean = normalizeUrl(originalUrl);
    if (!clean) return originalUrl;

    const startIndex = options.providerIndex !== undefined ? Math.abs(options.providerIndex) % PROVIDERS.length : 0;
    const order = [];
    for (let i = 0; i < PROVIDERS.length; i++) {
        order.push(PROVIDERS[(startIndex + i) % PROVIDERS.length]);
    }

    for (const provider of order) {
        try {
            const short = await provider.shorten(clean);
            if (short && short.startsWith('http')) {
                return short;
            }
        } catch (e) {
            // Переход к следующему провайдеру в каскаде
        }
    }

    return clean;
}

/**
 * Автоматически находит любые ссылки в переданном тексте (включая t.me без https://)
 * и безопасно клоачит/сокращает их, чередуя независимые сервисы сокращения
 */
async function cloakAllUrls(text) {
    if (!text || typeof text !== 'string') return text || '';

    // Регулярное выражение для поиска любых URL и Telegram-ссылок
    const urlPattern = /(?:https?:\/\/|t\.me\/|telegram\.me\/)[^\s"'<>]+/gi;
    const matches = text.match(urlPattern);
    if (!matches || matches.length === 0) return text;

    let result = text;
    for (let i = 0; i < matches.length; i++) {
        const rawMatch = matches[i];
        try {
            const short = await shortenUrl(rawMatch, { providerIndex: i });
            if (short && short !== rawMatch) {
                // Заменяем только первое текущее вхождение (позволяет чередовать ссылки при повторах)
                result = result.replace(rawMatch, short);
            }
        } catch (e) {
            // В случае критического сбоя оставляем как есть
        }
    }

    return result;
}

module.exports = {
    normalizeUrl,
    shortenUrl,
    cloakAllUrls
};
