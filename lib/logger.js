const fs = require('fs');
const path = require('path');

let baseDir = path.join(__dirname, '..');
if (process.pkg) baseDir = path.dirname(process.execPath);
const LOGS_DIR = path.join(baseDir, 'logs');

class Logger {
    constructor() {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        this.buffer = [];
        this.sseClients = new Set();
        this.maxBuffer = 200;
        this._stateDebounce = null;
    }

    _write(level, message) {
        const now = new Date();
        const timestamp = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const isoTime = now.toISOString();

        console.log(`[${timestamp}] ${message}`);

        // Async file write — non-blocking
        const dateStr = isoTime.split('T')[0];
        const line = `[${isoTime}] [${level}] ${message}\n`;
        fs.appendFile(path.join(LOGS_DIR, `${dateStr}.log`), line, () => {});
        if (level === 'error') {
            fs.appendFile(path.join(LOGS_DIR, 'errors.log'), `[${isoTime}] ${message}\n`, () => {});
        }

        const entry = { timestamp, level, message };
        this.buffer.push(entry);
        if (this.buffer.length > this.maxBuffer) this.buffer.shift();

        this.broadcast({ type: 'log', data: entry });
    }

    info(msg)    { this._write('info', msg); }
    success(msg) { this._write('success', msg); }
    warn(msg)    { this._write('warn', msg); }
    error(msg)   { this._write('error', msg); }

    addClient(res)    { this.sseClients.add(res); }
    removeClient(res) { this.sseClients.delete(res); }

    broadcast(event) {
        if (!this.sseClients.size) return;
        const data = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of this.sseClients) {
            try { client.write(data); } catch { this.sseClients.delete(client); }
        }
    }

    // Debounced state broadcast — prevents flooding on rapid state changes
    broadcastState(state) {
        if (this._stateDebounce) clearTimeout(this._stateDebounce);
        this._pendingState = state;
        this._stateDebounce = setTimeout(() => {
            this._stateDebounce = null;
            this.broadcast({ type: 'state', data: this._pendingState });
        }, 50);
    }

    getRecentLogs(count = 50) {
        return this.buffer.slice(-count);
    }
}

module.exports = new Logger();
