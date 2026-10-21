const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let baseDir = path.join(__dirname, '..');
if (process.pkg) {
    baseDir = path.dirname(process.execPath);
}

const DATA_DIR = path.join(baseDir, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'database.sqlite');
const ACCOUNTS_FILE = path.join(baseDir, 'accounts.json');

class Database {
    async init() {
        this.db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY,
                name TEXT,
                cookie TEXT,
                delayMinutes REAL,
                proxy TEXT,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER,
                file_name TEXT,
                file_id TEXT,
                status TEXT,
                error TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_history_account_file ON history(account_id, file_name);
            CREATE INDEX IF NOT EXISTS idx_history_filename_status ON history(file_name, status);
            CREATE TABLE IF NOT EXISTS reserve_cookies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cookie TEXT UNIQUE
            );
            CREATE TABLE IF NOT EXISTS warm_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cookie TEXT UNIQUE,
                account_name TEXT,
                videos_published INTEGER DEFAULT 0,
                last_published_at DATETIME,
                status TEXT DEFAULT 'warming',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS global_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS banned_proxies (
                proxy TEXT PRIMARY KEY,
                reason TEXT,
                banned_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_banned_proxies ON banned_proxies(proxy);
        `);

        try {
            await this.db.exec('ALTER TABLE accounts ADD COLUMN proxy TEXT');
        } catch (e) {
            // Column already exists
        }

        // Migration from old files
        if (fs.existsSync(ACCOUNTS_FILE)) {
            try {
                const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
                for (const acc of accounts) {
                    const row = await this.db.get('SELECT id FROM accounts WHERE id = ?', acc.id);
                    if (!row) {
                        await this.db.run(
                            'INSERT INTO accounts (id, name, cookie, delayMinutes, metadata) VALUES (?, ?, ?, ?, ?)',
                            [acc.id, acc.name, acc.cookie, acc.delayMinutes, JSON.stringify(acc.metadata)]
                        );
                    }
                }
                fs.renameSync(ACCOUNTS_FILE, `${ACCOUNTS_FILE}.bak`);
            } catch (e) {
                console.error('Migration error:', e);
            }
        }

        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.startsWith('history-') && file.endsWith('.json')) {
                    const accountId = parseInt(file.split('-')[1]);
                    if (isNaN(accountId)) continue;
                    try {
                        const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
                        // Batch insert to speed up
                        const stmt = await this.db.prepare('INSERT INTO history (account_id, file_name, file_id, status, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
                        for (const entry of history) {
                            const row = await this.db.get('SELECT id FROM history WHERE account_id = ? AND file_name = ?', [accountId, entry.fileName]);
                            if (!row) {
                                await stmt.run([accountId, entry.fileName, entry.fileId || null, entry.status || 'success', entry.error || null, entry.timestamp || new Date().toISOString()]);
                            }
                        }
                        await stmt.finalize();
                        fs.renameSync(path.join(DATA_DIR, file), path.join(DATA_DIR, `${file}.bak`));
                    } catch (e) { }
                }
            }
        }

        const hasMeta = await this.db.get("SELECT key FROM global_settings WHERE key = 'metadata'");
        if (!hasMeta) {
            let initialMeta = { title: '', caption: '', tgLink: '', randomMode: true, watermark: { enabled: false, text: '@ТвойКанал', fontSize: 36, color: 'white', bordercolor: 'black', borderwidth: 2, position: 'bottom-right' } };
            const oldMetaFile = path.join(__dirname, '..', 'global_metadata.json');
            if (fs.existsSync(oldMetaFile)) {
                try {
                    initialMeta = JSON.parse(fs.readFileSync(oldMetaFile, 'utf8'));
                } catch (e) {}
            }
            await this.saveGlobalMetadata(initialMeta);
        }
    }

    async getAccounts() {
        const rows = await this.db.all('SELECT * FROM accounts');
        return rows.map(r => ({
            id: r.id,
            name: r.name,
            cookie: r.cookie,
            delayMinutes: r.delayMinutes,
            proxy: r.proxy || '',
            metadata: r.metadata ? JSON.parse(r.metadata) : {}
        }));
    }

    async saveAccount(acc) {
        const row = await this.db.get('SELECT id FROM accounts WHERE id = ?', acc.id);
        if (row) {
            await this.db.run(
                'UPDATE accounts SET name=?, cookie=?, delayMinutes=?, proxy=?, metadata=? WHERE id=?',
                [acc.name, acc.cookie, acc.delayMinutes, acc.proxy || '', JSON.stringify(acc.metadata || {}), acc.id]
            );
        } else {
            await this.db.run(
                'INSERT INTO accounts (id, name, cookie, delayMinutes, proxy, metadata) VALUES (?, ?, ?, ?, ?, ?)',
                [acc.id, acc.name, acc.cookie, acc.delayMinutes, acc.proxy || '', JSON.stringify(acc.metadata || {})]
            );
        }
    }

    async deleteAccount(id) {
        await this.db.run('DELETE FROM accounts WHERE id = ?', id);
        await this.db.run('DELETE FROM history WHERE account_id = ?', id);
    }

    async addHistory(accountId, entry) {
        await this.db.run(
            'INSERT INTO history (account_id, file_name, file_id, status, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            [accountId, entry.fileName, entry.fileId || null, entry.status || 'success', entry.error || null, new Date().toISOString()]
        );
    }

    async getHistory(accountId, limit = 30) {
        const rows = await this.db.all('SELECT * FROM history WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?', [accountId, limit]);
        return rows.map(r => ({
            fileName: r.file_name,
            fileId: r.file_id,
            status: r.status,
            error: r.error,
            timestamp: r.timestamp
        }));
    }

    async getPublishedFiles(accountId) {
        const rows = await this.db.all(
            'SELECT id, account_id, file_name, file_id, timestamp FROM history WHERE account_id = ? AND status = "success" AND file_id IS NOT NULL ORDER BY id DESC',
            accountId
        );
        return rows.map(r => ({
            id: r.id,
            accountId: r.account_id,
            fileName: r.file_name,
            fileId: String(r.file_id),
            timestamp: r.timestamp
        }));
    }

    async getProcessedFileNames(accountId) {
        const rows = await this.db.all(
            `SELECT file_name FROM history 
             WHERE account_id = ? 
                OR status IN ('success', 'duplicate', 'error')`,
            accountId
        );
        return new Set(rows.map(r => r.file_name));
    }

    async clearAccountHistory(accountId) {
        await this.db.run('DELETE FROM history WHERE account_id = ?', accountId);
    }

    async clearAllHistory() {
        await this.db.run('DELETE FROM history');
    }

    async getReserveCookiesCount() {
        const row = await this.db.get('SELECT COUNT(*) as cnt FROM reserve_cookies');
        return row ? row.cnt : 0;
    }

    async addReserveCookies(cookies) {
        if (!cookies || !cookies.length) return;
        await this.db.run('BEGIN TRANSACTION');
        let stmt = null;
        try {
            stmt = await this.db.prepare('INSERT OR IGNORE INTO reserve_cookies (cookie) VALUES (?)');
            for (const c of cookies) {
                if (c && c.trim()) await stmt.run(c.trim());
            }
            await this.db.run('COMMIT');
        } catch (err) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            if (stmt) await stmt.finalize().catch(() => {});
        }
    }

    async popReserveCookie() {
        const row = await this.db.get('SELECT id, cookie FROM reserve_cookies LIMIT 1');
        if (row) {
            await this.db.run('DELETE FROM reserve_cookies WHERE id = ?', [row.id]);
            return row.cookie;
        }
        return null;
    }

    // --- Warm accounts ---

    async addWarmAccount(cookie) {
        await this.db.run(
            'INSERT OR IGNORE INTO warm_accounts (cookie, status, videos_published) VALUES (?, ?, ?)',
            [cookie, 'warming', 0]
        );
        const row = await this.db.get('SELECT id FROM warm_accounts WHERE cookie = ?', cookie);
        return row ? row.id : null;
    }

    async getWarmAccounts() {
        return await this.db.all('SELECT * FROM warm_accounts ORDER BY created_at DESC');
    }

    async getWarmAccount(id) {
        return await this.db.get('SELECT * FROM warm_accounts WHERE id = ?', id);
    }

    async updateWarmAccount(id, fields) {
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            sets.push(`${k} = ?`);
            vals.push(v);
        }
        vals.push(id);
        await this.db.run(`UPDATE warm_accounts SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    async deleteWarmAccount(id) {
        await this.db.run('DELETE FROM warm_accounts WHERE id = ?', id);
    }

    async getWarmAccountsCount() {
        const row = await this.db.get('SELECT COUNT(*) as cnt FROM warm_accounts WHERE status = ?', 'warming');
        return row ? row.cnt : 0;
    }

    /**
     * Move a warmed account to reserve_cookies pool and remove from warm_accounts.
     */
    async promoteWarmToReserve(id) {
        const row = await this.db.get('SELECT cookie FROM warm_accounts WHERE id = ?', id);
        if (row) {
            await this.db.run('INSERT OR IGNORE INTO reserve_cookies (cookie) VALUES (?)', [row.cookie]);
            await this.db.run('UPDATE warm_accounts SET status = ? WHERE id = ?', ['promoted', id]);
        }
    }

    async getGlobalMetadata() {
        const defaultMeta = { title: '', caption: '', tgLink: '', randomMode: true, watermark: { enabled: false, text: '@ТвойКанал', fontSize: 36, color: 'white', bordercolor: 'black', borderwidth: 2, position: 'bottom-right' } };
        const row = await this.db.get("SELECT value FROM global_settings WHERE key = 'metadata'");
        if (row && row.value) {
            try {
                const parsed = JSON.parse(row.value);
                if (!parsed.watermark) parsed.watermark = defaultMeta.watermark;
                return parsed;
            } catch (e) {
                return defaultMeta;
            }
        }
        return defaultMeta;
    }

    async saveGlobalMetadata(meta) {
        await this.db.run(
            "INSERT OR REPLACE INTO global_settings (key, value) VALUES ('metadata', ?)",
            [JSON.stringify(meta)]
        );
    }

    async addBannedProxy(proxy, reason = 'Account suspended') {
        const clean = String(proxy || '').trim();
        if (!clean) return;
        await this.db.run(
            'INSERT OR REPLACE INTO banned_proxies (proxy, reason, banned_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            [clean, reason]
        );
    }

    async isProxyBanned(proxy) {
        const clean = String(proxy || '').trim();
        if (!clean) return false;
        const row = await this.db.get('SELECT proxy FROM banned_proxies WHERE proxy = ?', clean);
        return !!row;
    }

    async getBannedProxies() {
        const rows = await this.db.all('SELECT * FROM banned_proxies ORDER BY banned_at DESC');
        return rows;
    }

    async getBannedProxiesSet() {
        const rows = await this.db.all('SELECT proxy FROM banned_proxies');
        return new Set(rows.map(r => r.proxy));
    }

    async getBannedProxiesCount() {
        const row = await this.db.get('SELECT COUNT(*) as count FROM banned_proxies');
        return row ? row.count : 0;
    }

    async unbanProxy(proxy) {
        const clean = String(proxy || '').trim();
        if (!clean) return;
        await this.db.run('DELETE FROM banned_proxies WHERE proxy = ?', clean);
    }

    async getProxyPointer() {
        const row = await this.db.get("SELECT value FROM global_settings WHERE key = 'proxy_pointer'");
        return row ? parseInt(row.value) || 0 : 0;
    }

    async saveProxyPointer(pointer) {
        await this.db.run(
            "INSERT OR REPLACE INTO global_settings (key, value) VALUES ('proxy_pointer', ?)",
            [String(parseInt(pointer) || 0)]
        );
    }

    async getDownloaderProxy() {
        const row = await this.db.get("SELECT value FROM global_settings WHERE key = 'downloader_proxy'");
        return row ? (row.value || '') : '';
    }

    async saveDownloaderProxy(proxy) {
        await this.db.run(
            "INSERT OR REPLACE INTO global_settings (key, value) VALUES ('downloader_proxy', ?)",
            [String(proxy || '').trim()]
        );
    }
}

module.exports = new Database();
