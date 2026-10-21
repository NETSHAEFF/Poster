const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const antiDetect = require('./anti-detect');

let baseDir = __dirname;
if (process.pkg) baseDir = path.dirname(process.execPath);
else baseDir = path.join(__dirname, '..');

const DATA_FILE = path.join(baseDir, 'data.txt');

class ProxyManager {
    constructor() {
        this.allProxies = [];
        this.bannedProxies = new Set();
        this.bannedSubnets = new Set();
        this.sessionFailed = new Set();
        this.pointer = 0;
        this.isInitialized = false;
        this._scanLock = null;
    }

    /**
     * Извлекает /24 IPv4 подсеть из URL прокси (например, "45.74.31")
     */
    extractSubnet(proxyUrl) {
        if (!proxyUrl || typeof proxyUrl !== 'string') return '';
        try {
            const clean = proxyUrl.trim().replace(/^[a-zA-Z0-9]+:\/\//, '');
            const withoutAuth = clean.replace(/^.*@/, '');
            const host = withoutAuth.split(':')[0];
            const parts = host.split('.');
            if (parts.length === 4 && parts.every(p => !isNaN(parseInt(p, 10)))) {
                return parts.slice(0, 3).join('.');
            }
            return host;
        } catch (e) {
            return '';
        }
    }

    /**
     * Инициализация менеджера: чтение data.txt, загрузка заблокированных прокси и указателя
     */
    async init() {
        if (this.isInitialized) return;
        this.loadProxies();
        
        try {
            await db.init();
            const bannedSet = await db.getBannedProxiesSet();
            this.bannedProxies = bannedSet;
            this.bannedSubnets = new Set();
            for (const p of bannedSet) {
                const sub = this.extractSubnet(p);
                if (sub) this.bannedSubnets.add(sub);
            }
            this.pointer = await db.getProxyPointer();
            if (this.pointer >= this.allProxies.length) {
                this.pointer = 0;
            }
        } catch (e) {
            logger.warn(`[ProxyManager] Ошибка чтения базы прокси: ${e.message}`);
        }

        this.isInitialized = true;
        logger.info(`🌐 [ProxyManager] Инициализирован. Всего в data.txt: ${this.allProxies.length}, в ЧС: ${this.bannedProxies.size} (скомпрометированных подсетей: ${this.bannedSubnets.size}), позиция: ${this.pointer}`);
    }

    /**
     * Читает и парсит data.txt с дедупликацией
     */
    loadProxies() {
        if (!fs.existsSync(DATA_FILE)) {
            logger.warn(`[ProxyManager] Файл data.txt не найден по пути: ${DATA_FILE}`);
            this.allProxies = [];
            return;
        }

        try {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            const lines = content.split(/\r?\n/);
            const seen = new Set();
            const subnetMap = new Map();

            for (const line of lines) {
                let p = line.trim();
                if (!p || p.startsWith('#')) continue;
                if (!p.includes('://')) {
                    p = 'socks5://' + p;
                }
                if (!seen.has(p)) {
                    seen.add(p);
                    const sub = this.extractSubnet(p);
                    if (!subnetMap.has(sub)) subnetMap.set(sub, []);
                    const list = subnetMap.get(sub);
                    // Ограничиваем не более 10 прокси на одну подсеть во избежание кластеризации
                    if (list.length < 10) {
                        list.push(p);
                    }
                }
            }

            // Чередуем (round-robin interleaving) прокси разных подсетей:
            // 1-й прокси из подсети А, затем 1-й из подсети B... и только потом 2-й круг.
            // Это гарантирует максимальную сетевую децентрализацию между аккаунтами.
            const interleaved = [];
            let maxInSubnet = 0;
            for (const list of subnetMap.values()) {
                if (list.length > maxInSubnet) maxInSubnet = list.length;
            }

            for (let round = 0; round < maxInSubnet; round++) {
                for (const list of subnetMap.values()) {
                    if (round < list.length) {
                        interleaved.push(list[round]);
                    }
                }
            }

            this.allProxies = interleaved;
        } catch (e) {
            logger.error(`[ProxyManager] Ошибка чтения data.txt: ${e.message}`);
            this.allProxies = [];
        }
    }

    /**
     * Проверяет, является ли ошибка сбоем прокси/сети (таймаут, разрыв, сброс соединения, отказ прокси)
     */
    isProxyError(err) {
        if (!err) return false;
        const msg = String(err.message || '').toLowerCase();
        const code = String(err.code || '').toLowerCase();
        const keywords = [
            'econnreset', 'etimedout', 'econnrefused', 'ehostunreach', 'enotfound',
            'esocket', 'epipe', 'cert_has_expired', 'socket hang up', 'proxy',
            'socks', 'tunnel', 'client network socket disconnected', 'connect error',
            '502 bad gateway', '503 service unavailable', '504 gateway timeout',
            '407 proxy authentication required', 'connection timed out', 'network error',
            'unexpected end of file', 'socket closed', 'premature close', 'eai_again'
        ];
        return keywords.some(k => msg.includes(k) || code.includes(k));
    }

    /**
     * Проверяет работоспособность конкретного прокси
     */
    async testProxy(proxyUrl, timeoutMs = 4000) {
        const clean = String(proxyUrl || '').trim();
        if (!clean) return { ok: false, error: 'Empty proxy' };

        const start = Date.now();
        try {
            const { httpsAgent } = antiDetect.createHttpAgents(clean, 'proxy_tester');
            const resp = await axios.get(`${config.siteDomain}/robots.txt`, {
                headers: {
                    'User-Agent': antiDetect.BROWSER_PROFILES[0].userAgent,
                    'Accept': '*/*'
                },
                httpsAgent,
                proxy: false,
                signal: AbortSignal.timeout(timeoutMs),
                timeout: timeoutMs
            });

            const latency = Date.now() - start;
            if (resp.status >= 200 && resp.status < 400) {
                return { ok: true, latency, proxy: clean };
            }
            return { ok: false, error: `Status ${resp.status}`, latency, proxy: clean };
        } catch (e) {
            return { ok: false, error: e.message, latency: Date.now() - start, proxy: clean };
        }
    }

    /**
     * Добавляет прокси в чёрный список (при бане аккаунта или необратимой ошибке)
     */
    async banProxy(proxyUrl, reason = 'Account suspended') {
        const clean = String(proxyUrl || '').trim();
        if (!clean) return;

        this.bannedProxies.add(clean);
        const subnet = this.extractSubnet(clean);
        if (subnet) {
            this.bannedSubnets.add(subnet);
            logger.warn(`🚫 [ProxyManager] Подсеть ${subnet}.0/24 добавлена в список компрометации (причина: ${reason}).`);
        }
        await db.addBannedProxy(clean, reason);
        logger.warn(`🚫 [ProxyManager] Прокси ${clean} добавлен в ЧЁРНЫЙ СПИСОК (${reason}) и навсегда исключён из пула.`);
    }

    /**
     * Проверяет, находится ли прокси в чёрном списке
     */
    isBanned(proxyUrl) {
        const clean = String(proxyUrl || '').trim();
        if (!clean) return false;
        return this.bannedProxies.has(clean);
    }

    /**
     * Находит следующий рабочий, незаблокированный прокси из data.txt.
     * Гарантирует изоляцию подсетей (/24) между аккаунтами и исключает скомпрометированные сети.
     */
    async findWorkingProxy({ excludeList = [], batchSize = 50, maxScan = 2500, timeoutMs = 3000 } = {}) {
        await this.init();

        if (!this.allProxies.length) {
            throw new Error('Файл data.txt пуст или отсутствует!');
        }

        const excludeSet = new Set([
            ...excludeList.map(p => String(p || '').trim()),
            ...this.bannedProxies
        ]);

        const activeSubnets = new Set(excludeList.map(p => this.extractSubnet(p)).filter(Boolean));

        let scannedCount = 0;
        let startIndex = this.pointer;
        const total = this.allProxies.length;

        logger.info(`🔍 [ProxyManager] Поиск рабочего прокси (старт с #${startIndex}, активных подсетей: ${activeSubnets.size}, ЧС подсетей: ${this.bannedSubnets.size})...`);

        while (scannedCount < maxScan && scannedCount < total) {
            const batch = [];
            const batchSubnets = new Set();

            while (batch.length < batchSize && scannedCount < total && scannedCount < maxScan) {
                const candidate = this.allProxies[this.pointer];
                // Шагаем с небольшим псевдослучайным шагом 1..3 для распределения по пулу
                const stride = Math.floor(Math.random() * 3) + 1;
                this.pointer = (this.pointer + stride) % total;
                scannedCount++;

                if (candidate && !excludeSet.has(candidate) && !this.sessionFailed.has(candidate)) {
                    const candidateSubnet = this.extractSubnet(candidate);
                    // Изоляция: не брать подсеть, занятую другим активным аккаунтом
                    if (candidateSubnet && activeSubnets.has(candidateSubnet)) {
                        continue;
                    }
                    // Безопасность: не брать подсеть, на которой был забанен аккаунт
                    if (candidateSubnet && this.bannedSubnets.has(candidateSubnet)) {
                        continue;
                    }
                    // Разнообразие пачки: не тестировать одну и ту же подсеть дважды в одной пачке
                    if (candidateSubnet && batchSubnets.has(candidateSubnet)) {
                        continue;
                    }

                    if (candidateSubnet) batchSubnets.add(candidateSubnet);
                    batch.push(candidate);
                }
            }

            if (!batch.length) {
                if (scannedCount >= total || scannedCount >= maxScan) break;
                continue;
            }

            // Параллельное тестирование пачки уникальных подсетей
            const testPromises = batch.map(p => this.testProxy(p, timeoutMs));
            const results = await Promise.all(testPromises);

            for (const res of results) {
                if (res.ok) {
                    await db.saveProxyPointer(this.pointer);
                    const chosenSubnet = this.extractSubnet(res.proxy);
                    logger.success(`✅ [ProxyManager] Найден рабочий прокси: ${res.proxy} (подсеть ${chosenSubnet}.0/24, отклик: ${res.latency}мс)`);
                    return res.proxy;
                } else {
                    this.sessionFailed.add(res.proxy);
                }
            }
        }

        await db.saveProxyPointer(this.pointer);
        throw new Error(`Не удалось найти рабочий прокси среди проверенных ${scannedCount} адресов в data.txt. Попробуйте повторить поиск.`);
    }

    /**
     * Автоматически подбирает и закрепляет рабочий прокси за конкретным аккаунтом с гарантией уникальности подсети
     */
    async assignWorkingProxyToAccount(acc, allAccounts = []) {
        await this.init();
        const otherProxies = (allAccounts || [])
            .filter(a => a.id !== acc.id && a.proxy)
            .map(a => a.proxy);

        logger.info(`🎲 [ProxyManager] Подбор изолированного рабочего прокси для [${acc.name}]...`);
        const workingProxy = await this.findWorkingProxy({ excludeList: otherProxies, batchSize: 50, maxScan: 2500, timeoutMs: 3000 });

        acc.proxy = workingProxy;
        await db.saveAccount(acc);
        logger.success(`✨ [ProxyManager] Для [${acc.name}] назначен прокси: ${workingProxy}`);
        return workingProxy;
    }

    /**
     * Выполняет авто-ротацию прокси для аккаунта при сбое сети или недоступности текущего прокси
     */
    async rotateProxy(acc, allAccounts = [], reason = 'Сбой подключения') {
        await this.init();
        const oldProxy = acc.proxy;
        if (oldProxy) {
            this.sessionFailed.add(oldProxy);
            logger.warn(`[ProxyManager] 🔄 Ротация прокси для [${acc.name}] (причина: ${reason}). Прежний прокси: ${oldProxy}`);
        }

        const otherProxies = (allAccounts || [])
            .filter(a => a.id !== acc.id && a.proxy)
            .map(a => a.proxy);

        const newProxy = await this.findWorkingProxy({
            excludeList: otherProxies,
            batchSize: 50,
            maxScan: 2500,
            timeoutMs: 3000
        });

        acc.proxy = newProxy;
        await db.saveAccount(acc);
        logger.success(`[ProxyManager] 🌐 Для [${acc.name}] успешно назначен новый рабочий прокси: ${newProxy}`);
        return newProxy;
    }

    /**
     * Возвращает статистику пула прокси
     */
    async getStats(allAccounts = []) {
        await this.init();
        const assignedSet = new Set((allAccounts || []).map(a => String(a.proxy || '').trim()).filter(Boolean));
        
        return {
            total: this.allProxies.length,
            bannedCount: this.bannedProxies.size,
            bannedSubnetsCount: this.bannedSubnets.size,
            assignedCount: assignedSet.size,
            availableCount: Math.max(0, this.allProxies.length - this.bannedProxies.size - assignedSet.size),
            pointer: this.pointer,
            hasDataFile: fs.existsSync(DATA_FILE)
        };
    }
}

module.exports = new ProxyManager();
