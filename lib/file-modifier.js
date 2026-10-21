const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execSync, spawn } = require('child_process');
const config = require('./config');
const logger = require('./logger');

let sharp;
try { sharp = require('sharp'); sharp.cache(false); } catch { sharp = null; }

let baseDir = path.join(__dirname, '..');
if (process.pkg) baseDir = path.dirname(process.execPath);
const TEMP_DIR = path.join(baseDir, 'temp');

class FileModifier {
    constructor() {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        this._ffmpeg = null;
    }

    _getFfmpegPath() {
        if (process.pkg) {
            const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
            const localBin = path.join(path.dirname(process.execPath), exeName);
            if (fs.existsSync(localBin)) return localBin;
        }

        // 1. Try system-installed ffmpeg (recommended on Ubuntu/Debian)
        try {
            execSync('ffmpeg -version', { stdio: 'ignore', timeout: 3000 });
            return 'ffmpeg';
        } catch (e) {}

        // 2. Try ffmpeg-static npm package
        try {
            const staticPath = require('ffmpeg-static');
            if (staticPath && fs.existsSync(staticPath)) {
                if (process.platform !== 'win32') {
                    try { fs.chmodSync(staticPath, 0o755); } catch (e) {}
                }
                return staticPath;
            }
        } catch (e) {}

        return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }

    get ffmpegAvailable() {
        if (this._ffmpeg === null) {
            try { 
                const ffmpegPath = this._getFfmpegPath();
                execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore', timeout: 5000 }); 
                this._ffmpeg = true; 
            }
            catch { this._ffmpeg = false; }
        }
        return this._ffmpeg;
    }

    _tempPath(ext, prefix = '') {
        return path.join(TEMP_DIR, `${prefix}${crypto.randomBytes(8).toString('hex')}${ext}`);
    }

    /**
     * Модифицирует файл для уникальности. Возвращает путь к временному файлу.
     * Оригинал НЕ трогает. После загрузки нужно вызвать cleanup(tempPath).
     * @param {string} filePath — путь к оригинальному файлу
     * @param {number|string} accountId — ID аккаунта для уникального префикса temp-файла
     */
    async modify(filePath, accountId = '', watermark = null, mediaInfo = null) {
        const ext = path.extname(filePath).toLowerCase();
        const prefix = accountId ? `acc${accountId}_` : '';
        const isVideo = config.videoExtensions.includes(ext);

        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && sharp) {
            return await this._modifyImage(filePath, ext, prefix);
        }
        if (isVideo) {
            if (!this.ffmpegAvailable) {
                throw new Error('ffmpeg недоступен для обработки видео. Загрузка исходного видео заблокирована во избежание бана.');
            }
            return await this._modifyVideo(filePath, ext, prefix, watermark, mediaInfo);
        }
        // Fallback: raw byte modification ONLY for non-video files
        return this._modifyRaw(filePath, ext, prefix);
    }

    async _modifyImage(filePath, ext, prefix = '') {
        const output = this._tempPath(ext, prefix);
        const quality = 93 + Math.floor(Math.random() * 6); // 93-98
        const comment = crypto.randomBytes(12).toString('hex');

        let pipeline = sharp(filePath);

        // Случайная незаметная модификация
        const roll = Math.random();
        if (roll < 0.33) {
            pipeline = pipeline.modulate({ brightness: 1 + (Math.random() * 0.008 - 0.004) });
        } else if (roll < 0.66) {
            pipeline = pipeline.sharpen({ sigma: 0.3 + Math.random() * 0.2 });
        } else {
            pipeline = pipeline.gamma(1.0 + Math.random() * 0.04);
        }

        if (ext === '.jpg' || ext === '.jpeg') {
            await pipeline
                .withMetadata({ exif: { IFD0: { ImageDescription: comment } } })
                .jpeg({ quality })
                .toFile(output);
        } else if (ext === '.png') {
            await pipeline
                .png({ compressionLevel: 6 + Math.floor(Math.random() * 3) })
                .toFile(output);
        } else if (ext === '.webp') {
            await pipeline.webp({ quality }).toFile(output);
        }

        return output;
    }

    _getFontPath() {
        // 1. Embedded project font (works everywhere out-of-the-box on Linux & Windows)
        const projectFont = path.join(baseDir, 'assets', 'fonts', 'font.ttf');
        if (fs.existsSync(projectFont)) return projectFont;

        // 2. Windows system font
        if (process.platform === 'win32') {
            const winFont = 'C:/Windows/Fonts/arial.ttf';
            if (fs.existsSync(winFont)) return winFont;
        } else {
            // 3. Linux Ubuntu system fonts
            const linuxFonts = [
                '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
                '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
                '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf'
            ];
            for (const f of linuxFonts) {
                if (fs.existsSync(f)) return f;
            }
        }
        return null;
    }

    _sanitizeColor(val, fallback = 'white') {
        if (!val || typeof val !== 'string') return fallback;
        const trimmed = val.trim();
        // Поддержка стандартного hex (#fff, #ffffff, #ffffffff, 0xffffff)
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return trimmed;
        if (/^0x[0-9a-fA-F]{6}$/i.test(trimmed)) return trimmed;
        const validNames = ['white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'orange', 'gray', 'grey', 'pink', 'purple', 'gold'];
        if (validNames.includes(trimmed.toLowerCase())) return trimmed.toLowerCase();
        // Попытка восстановить hex без лишних символов
        const cleanHex = trimmed.replace(/[^0-9a-fA-F]/g, '');
        if (cleanHex.length >= 6) return '#' + cleanHex.slice(0, 6);
        return fallback;
    }

    _modifyVideo(filePath, ext, prefix = '', watermark = null, mediaInfo = null) {
        const output = this._tempPath(ext, prefix);
        const rndTitle = crypto.randomBytes(6).toString('hex');
        const rndComment = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        let durationSec = mediaInfo?.durationSec;
        let sizeBytes = mediaInfo?.size;
        if (!sizeBytes) {
            try { sizeBytes = fs.statSync(filePath).size; } catch {}
        }

        const hasWatermark = watermark && watermark.enabled;

        // --- Антидетект и обход перцептивных хэшей (pHash / BlockHash / dHash / AcoustID) ---
        // 1. Случайный микро-кроп от 2 до 6 пикселей с гарантией четности для YUV420p
        const rndCropW = 2 + (Math.floor(Math.random() * 3) * 2);
        const rndCropH = 2 + (Math.floor(Math.random() * 3) * 2);
        const vfFilters = [
            `crop=w=trunc((iw-${rndCropW})/2)*2:h=trunc((ih-${rndCropH})/2)*2`
        ];

        // 2. Случайный незаметный сдвиг цветовых компонентов, гаммы и контраста (полностью меняет пиксельные матрицы)
        const contrast = (1.0 + (Math.random() * 0.02 - 0.01)).toFixed(4); // 0.9900 .. 1.0100
        const brightness = ((Math.random() * 0.008 - 0.004)).toFixed(4);  // -0.0040 .. 0.0040
        const saturation = (1.0 + (Math.random() * 0.02 - 0.01)).toFixed(4); // 0.9900 .. 1.0100
        const gamma = (1.0 + (Math.random() * 0.02 - 0.01)).toFixed(4);      // 0.9900 .. 1.0100
        vfFilters.push(`eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}:gamma=${gamma}`);

        // 3. Микро-сдвиг временных меток кадров (PTS) для изменения таймингов и разрушения попиксельных сигнатур
        const ptsMult = (1.0 + (Math.random() * 0.002 - 0.001)).toFixed(6);
        vfFilters.push(`setpts=${ptsMult}*PTS`);

        // 4. Тонкий unsharp фильтр для модификации резкости
        const unsharp = (0.05 + Math.random() * 0.15).toFixed(3);
        vfFilters.push(`unsharp=3:3:${unsharp}:3:3:0.0`);

        if (hasWatermark) {
            const wm = watermark;
            // Джиттер позиции водяного знака для предотвращения поэлементного сравнения масок
            const rndJitterX = Math.floor(Math.random() * 13) - 6; // -6 .. +6 px
            const rndJitterY = Math.floor(Math.random() * 13) - 6;

            let x, y;
            switch (wm.position) {
                case 'center': x = `(w-text_w)/2+(${rndJitterX})`; y = `(h-text_h)/2+(${rndJitterY})`; break;
                case 'top-left': x = `${Math.max(4, 10 + rndJitterX)}`; y = `${Math.max(4, 10 + rndJitterY)}`; break;
                case 'top-right': x = `w-text_w-${Math.max(4, 10 + rndJitterX)}`; y = `${Math.max(4, 10 + rndJitterY)}`; break;
                case 'bottom-left': x = `${Math.max(4, 10 + rndJitterX)}`; y = `h-text_h-${Math.max(4, 10 + rndJitterY)}`; break;
                case 'bottom-right':
                default: x = `w-text_w-${Math.max(4, 10 + rndJitterX)}`; y = `h-text_h-${Math.max(4, 10 + rndJitterY)}`; break;
            }

            const { parseSpintax } = require('./random-meta');
            const evaluatedText = parseSpintax(String(wm.text || ''));
            const safeText = evaluatedText
                .replace(/\\/g, '\\\\')
                .replace(/:/g, '\\:')
                .replace(/'/g, "\\'")
                .replace(/%/g, '\\%');

            const fontPath = this._getFontPath();
            let fontOption = '';
            if (fontPath) {
                let formattedFont = fontPath.replace(/\\/g, '/');
                if (process.platform === 'win32') {
                    formattedFont = formattedFont.replace(/^([a-zA-Z]):/, (m, d) => d + '\\:');
                }
                fontOption = `fontfile='${formattedFont}':`;
            } else {
                logger.warn(`[Watermark] Шрифт TTF не найден ни в проекте (assets/fonts/font.ttf), ни в системе!`);
            }

            const fontColor = this._sanitizeColor(wm.color, 'white');
            const borderColor = this._sanitizeColor(wm.bordercolor, 'black');
            const fontSize = Math.max(12, Math.min(120, parseInt(wm.fontSize) || 36));
            const borderWidth = Math.max(0, Math.min(20, parseInt(wm.borderwidth) || 2));
            const alpha = (0.82 + Math.random() * 0.14).toFixed(2); // 0.82 .. 0.96 (естественная полупрозрачность)

            vfFilters.push(`drawtext=${fontOption}text='${safeText}':fontcolor=${fontColor}:fontsize=${fontSize}:borderw=${borderWidth}:bordercolor=${borderColor}:alpha=${alpha}:x=${x}:y=${y}`);
        }

        // 5. Аудио антидетект: микро-сдвиг темпа и громкости (полностью ломает акустический отпечаток AcoustID/Chromaprint)
        const rndTempo = (1.0 + (Math.random() * 0.003 - 0.0015)).toFixed(5); // 0.9985 .. 1.0015
        const rndVol = (1.0 + (Math.random() * 0.02 - 0.01)).toFixed(3);     // 0.990 .. 1.010
        const afFilters = [
            `atempo=${rndTempo}`,
            `volume=${rndVol}`
        ];

        // 6. Динамические параметры кодирования
        const rndCrf = String(24 + Math.floor(Math.random() * 4)); // 24 .. 27
        const audioBitrates = ['128k', '160k', '192k'];
        const rndAudioBitrate = audioBitrates[Math.floor(Math.random() * audioBitrates.length)];
        const rndSampleRate = Math.random() < 0.5 ? '44100' : '48000';

        const args = [
            '-threads', '0',
            '-i', filePath,
            '-vf', vfFilters.join(','),
            '-af', afFilters.join(','),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', rndCrf,
            '-c:a', 'aac',
            '-b:a', rndAudioBitrate,
            '-ar', rndSampleRate,
            '-map_metadata', '-1',
            '-map_chapters', '-1',
            '-metadata', `title=${rndTitle}`,
            '-metadata', `comment=${rndComment}`,
            '-metadata', `artist=${crypto.randomBytes(4).toString('hex')}`,
            '-metadata', `encoder=v${crypto.randomBytes(3).toString('hex')}`,
            '-y', output
        ];

        // Динамический таймаут: от 5 до 15 минут в зависимости от длины видео
        const timeoutMs = durationSec
            ? Math.min(900000, Math.max(300000, Math.round(durationSec * 1500)))
            : 300000;

        return new Promise((resolve, reject) => {
            const ffmpegPath = this._getFfmpegPath();
            const proc = spawn(ffmpegPath, args);
            
            let stderrData = '';
            if (proc.stderr) {
                proc.stderr.on('data', chunk => {
                    stderrData += chunk.toString();
                    if (stderrData.length > 4000) stderrData = stderrData.slice(-4000);
                });
            }

            let isDone = false;
            const timeout = setTimeout(() => {
                if (!isDone) {
                    isDone = true;
                    logger.error(`[Modifier] Таймаут обработки видео ffmpeg (${Math.round(timeoutMs / 1000)}с)`);
                    try { proc.kill('SIGKILL'); } catch (e) {}
                    this.cleanup(output);
                    reject(new Error(`Таймаут обработки видео ffmpeg (${Math.round(timeoutMs / 1000)}с). Исходный файл не отправлен во избежание бана.`));
                }
            }, timeoutMs);

            proc.on('close', (code) => {
                if (isDone) return;
                isDone = true;
                clearTimeout(timeout);
                if (code === 0) {
                    try {
                        // Добавляем микро-паддинг случайных байт для гарантированной уникальности бинарного хэша (MD5/SHA)
                        const padBytes = crypto.randomBytes(16 + Math.floor(Math.random() * 48));
                        fs.appendFileSync(output, padBytes);
                    } catch (padErr) {}
                    logger.success(`[Modifier] Видео успешно уникализировано (глубокий видео/аудио антидетект + уникальные хэши)`);
                    resolve(output);
                } else {
                    const lastErr = stderrData.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
                    logger.error(`[Modifier] Ошибка ffmpeg (код ${code}): ${lastErr || 'Неизвестная ошибка'}`);
                    this.cleanup(output);
                    reject(new Error(`Ошибка ffmpeg (код ${code}): ${lastErr || 'Неизвестная ошибка'}. Исходный файл не отправлен.`));
                }
            });

            proc.on('error', (err) => {
                if (isDone) return;
                isDone = true;
                clearTimeout(timeout);
                logger.error(`[Modifier] Не удалось запустить ffmpeg: ${err.message}`);
                this.cleanup(output);
                reject(new Error(`Не удалось запустить ffmpeg: ${err.message}. Исходный файл не отправлен.`));
            });
        });
    }

    _modifyRaw(filePath, ext, prefix = '') {
        const output = this._tempPath(ext, prefix);
        const padding = crypto.randomBytes(32 + Math.floor(Math.random() * 96));
        return new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(filePath);
            const writeStream = fs.createWriteStream(output);
            readStream.pipe(writeStream, { end: false });
            readStream.on('end', () => {
                writeStream.write(padding);
                writeStream.end();
                resolve(output);
            });
            readStream.on('error', reject);
            writeStream.on('error', reject);
        });
    }

    cleanup(tempPath) {
        try {
            if (tempPath && tempPath.startsWith(TEMP_DIR) && fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch { }
    }

    cleanupAll() {
        try {
            if (fs.existsSync(TEMP_DIR)) {
                for (const f of fs.readdirSync(TEMP_DIR)) {
                    try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch { }
                }
            }
        } catch { }
    }
}

module.exports = FileModifier;
