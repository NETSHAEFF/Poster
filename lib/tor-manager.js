const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const logger = require('./logger');

const DEFAULT_TOR_PATH = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Tor\\tor.exe';
const DEFAULT_TORRC = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Tor\\torrc';

class TorManager {
    constructor() {
        this.host = '127.0.0.1';
        this.port = null;
        this.isRunning = false;
        this.accountCircuits = new Map(); // accountId -> number
        this.torProcess = null;
        this.currentIp = null;
    }

    async init() {
        let detected = await this.detectPort();
        if (!detected) {
            logger.info('🧅 [TorManager] Tor не обнаружен на портах 9150/9050. Запуск процесса tor.exe...');
            await this.startTor();
            detected = await this.detectPort();
        }

        if (detected) {
            this.port = detected;
            this.isRunning = true;
            logger.success(`🧅 [TorManager] Сервис Tor активен и подключен (порт ${this.port})`);

            try {
                const info = await this.checkIp();
                this.currentIp = info.ip;
                logger.success(`🧅 [TorManager] Текущий выходной IP Tor: ${info.ip} (отклик: ${info.latency}мс)`);
            } catch (e) {
                logger.warn(`🧅 [TorManager] Проверка IP через Tor: ${e.message}`);
            }
        } else {
            logger.error('❌ [TorManager] Не удалось подключиться к Tor на портах 9150 или 9050');
            this.isRunning = false;
        }

        return this.isRunning;
    }

    checkPort(port, host = '127.0.0.1', timeout = 1500) {
        return new Promise(resolve => {
            const socket = new net.Socket();
            socket.setTimeout(timeout);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.connect(port, host);
        });
    }

    async detectPort() {
        if (await this.checkPort(9150, this.host)) return 9150;
        if (await this.checkPort(9050, this.host)) return 9050;
        return null;
    }

    async startTor() {
        if (!fs.existsSync(DEFAULT_TOR_PATH)) {
            logger.warn(`[TorManager] Исполняемый файл Tor не найден: ${DEFAULT_TOR_PATH}`);
            return false;
        }

        const args = [];
        if (fs.existsSync(DEFAULT_TORRC)) {
            args.push('-f', DEFAULT_TORRC);
        }

        try {
            this.torProcess = spawn(DEFAULT_TOR_PATH, args, {
                detached: true,
                stdio: 'ignore'
            });
            this.torProcess.unref();

            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 500));
                const port = await this.detectPort();
                if (port) return true;
            }
        } catch (e) {
            logger.error(`[TorManager] Ошибка запуска tor.exe: ${e.message}`);
        }
        return false;
    }

    getProxyForAccount(accountId) {
        if (!this.port) this.port = 9150;
        const circuit = this.accountCircuits.get(accountId) || 1;
        // Tor SOCKS5 circuit isolation: уникальные логин/пароль создают полностью изолированный контур и свой IP
        return `socks5h://acc_${accountId}_${circuit}:tor@${this.host}:${this.port}`;
    }

    rotateCircuit(accountId) {
        const current = this.accountCircuits.get(accountId) || 1;
        const next = current + 1;
        this.accountCircuits.set(accountId, next);
        return this.getProxyForAccount(accountId);
    }

    async checkIp(proxyUrl) {
        const proxy = proxyUrl || (this.port ? `socks5h://probe_${Date.now()}:tor@${this.host}:${this.port}` : null);
        if (!proxy) throw new Error('Tor не запущен');

        const agent = new SocksProxyAgent(proxy);
        const start = Date.now();
        const res = await axios.get('https://check.torproject.org/api/ip', {
            httpsAgent: agent,
            proxy: false,
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const latency = Date.now() - start;
        return {
            ip: res.data?.IP || 'Неизвестно',
            isTor: !!res.data?.IsTor,
            latency
        };
    }

    async getStats(accounts = []) {
        return {
            enabled: true,
            running: this.isRunning,
            port: this.port || 9150,
            host: this.host,
            currentIp: this.currentIp || 'Активен',
            activeAccounts: accounts.length,
            circuitMode: 'Изолированный маршрут для каждого аккаунта (Per-Account Tor Circuit)'
        };
    }
}

module.exports = new TorManager();
