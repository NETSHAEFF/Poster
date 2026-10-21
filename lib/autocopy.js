const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const db = require('./db');

let baseDir = path.join(__dirname, '..');
if (process.pkg) baseDir = path.dirname(process.execPath);
const TDATA_UPLOAD_DIR = path.join(baseDir, 'uploads', 'tdata');
if (!fs.existsSync(TDATA_UPLOAD_DIR)) {
    fs.mkdirSync(TDATA_UPLOAD_DIR, { recursive: true });
}

let tasks = [];
let isProcessing = false;
let pythonCmd = 'python';

function checkPython() {
    exec('python3 --version', (err) => {
        if (!err) {
            pythonCmd = 'python3';
            logger.info(`AutoCopy: Обнаружен исполняемый файл Python: ${pythonCmd}`);
        } else {
            exec('python --version', (err2) => {
                if (!err2) {
                    pythonCmd = 'python';
                    logger.info(`AutoCopy: Обнаружен исполняемый файл Python: ${pythonCmd}`);
                } else {
                    logger.warn('AutoCopy: Команда "python" или "python3" не найдена. Убедитесь, что Python установлен.');
                }
            });
        }
    });
}
checkPython();

function getTasks() {
    return tasks.map(t => ({
        id: t.id,
        name: t.name,
        size: t.size,
        status: t.status,
        details: t.details,
        timestamp: t.timestamp
    }));
}

function clearTasks() {
    tasks = tasks.filter(t => t.status === 'processing' || t.status === 'pending');
}

function deleteTask(id) {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx !== -1) {
        const task = tasks[idx];
        if (task.status !== 'processing') {
            // Delete temp file if exists
            if (task.filePath && fs.existsSync(task.filePath)) {
                try { fs.unlinkSync(task.filePath); } catch (e) {}
            }
            tasks.splice(idx, 1);
        }
    }
}

async function addTask(name, size, tempPath, getFullState) {
    const id = Date.now().toString() + '_' + Math.random().toString(36).substring(2, 7);
    const destPath = path.join(TDATA_UPLOAD_DIR, `${id}_${name}`);
    
    try {
        fs.renameSync(tempPath, destPath);
    } catch (e) {
        logger.error(`AutoCopy: Не удалось переместить архив ${name}: ${e.message}`);
        return;
    }

    const task = {
        id,
        name,
        size,
        status: 'pending',
        details: 'В очереди...',
        cookie: '',
        filePath: destPath,
        timestamp: new Date().toISOString()
    };

    tasks.push(task);
    logger.info(`AutoCopy: Добавлен архив ${name} в очередь`);
    
    // Trigger queue processor in background
    triggerProcessing(getFullState);
}

function triggerProcessing(getFullState) {
    if (isProcessing) return;
    isProcessing = true;
    _processQueue(getFullState).finally(() => {
        isProcessing = false;
    });
}

async function _processQueue(getFullState) {
    while (true) {
        const task = tasks.find(t => t.status === 'pending');
        if (!task) break;

        task.status = 'processing';
        task.details = 'Распаковка и авторизация...';
        logger.broadcastState(await getFullState());

        logger.info(`AutoCopy: Запуск обработки архива ${task.name}...`);
        
        try {
            const result = await runPythonScript(task.filePath, task);
            if (result.success) {
                task.status = 'success';
                task.details = `Импортировано кук: ${result.cookies.length}`;
                task.cookie = result.cookies[0] || '';
                
                // Add to reserve cookies in database
                await db.addReserveCookies(result.cookies);
                logger.success(`AutoCopy: Успешно импортировано ${result.cookies.length} кук из архива ${task.name}!`);
            } else {
                task.status = 'failed';
                task.details = result.error || 'Ошибка конвертации';
                logger.error(`AutoCopy: Ошибка обработки ${task.name}: ${task.details}`);
            }
        } catch (err) {
            task.status = 'failed';
            task.details = err.message;
            logger.error(`AutoCopy: Ошибка обработки ${task.name}: ${err.message}`);
        }

        // Clean up uploaded zip file
        if (fs.existsSync(task.filePath)) {
            try { fs.unlinkSync(task.filePath); } catch (e) {}
        }

        logger.broadcastState(await getFullState());
    }
}

function runPythonScript(filePath, task) {
    return new Promise((resolve) => {
        const scriptPath = path.join(__dirname, '..', 'AutoCopy', 'process_single.py');
        const cmd = `"${pythonCmd}" "${scriptPath}" "${filePath}"`;

        const child = exec(cmd, { 
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        }, (error, stdout, stderr) => {
            const stdoutStr = stdout ? stdout.toString().trim() : '';
            const stderrStr = stderr ? stderr.toString().trim() : '';

            // Extract all cookies from SUCCESS: lines
            const cookies = [];
            const lines = stdoutStr.split(/\r?\n/);
            for (const line of lines) {
                const match = line.match(/^SUCCESS:(.*)$/);
                if (match) {
                    cookies.push(match[1].trim());
                }
            }

            if (cookies.length > 0) {
                return resolve({ success: true, cookies: cookies });
            }

            if (error) {
                if (error.message && (error.message.includes('not found') || error.message.includes('не является внутренней или внешней'))) {
                    return resolve({ 
                        success: false, 
                        error: `Интерпретатор Python (${pythonCmd}) не найден. Убедитесь, что Python установлен в системе и доступен в PATH.` 
                    });
                }
                const match = stdoutStr.match(/^ERROR:(.*)$/m);
                if (match) {
                    return resolve({ success: false, error: match[1].trim() });
                }
                return resolve({ success: false, error: stderrStr || error.message });
            }

            const errorMatch = stdoutStr.match(/^ERROR:(.*)$/m);
            if (errorMatch) {
                return resolve({ success: false, error: errorMatch[1].trim() });
            }

            return resolve({ success: false, error: stdoutStr || 'Скрипт не вернул SUCCESS' });
        });

        // Stream real-time logs to the logger
        child.stdout.on('data', (data) => {
            const lines = data.toString().split(/\r?\n/);
            for (const line of lines) {
                const cleanLine = line.trim();
                if (!cleanLine) continue;
                if (cleanLine.startsWith('SUCCESS:')) {
                    logger.success(`AutoCopy [${task.name}]: Успешно импортирован аккаунт`);
                } else if (cleanLine.startsWith('ERROR:')) {
                    logger.error(`AutoCopy [${task.name}]: ${cleanLine.substring(6).trim()}`);
                } else {
                    logger.info(`AutoCopy [${task.name}]: ${cleanLine}`);
                }
            }
        });

        child.stderr.on('data', (data) => {
            const lines = data.toString().split(/\r?\n/);
            for (const line of lines) {
                const cleanLine = line.trim();
                if (cleanLine) {
                    logger.error(`AutoCopy [${task.name}] (stderr): ${cleanLine}`);
                }
            }
        });
    });
}

module.exports = {
    getTasks,
    clearTasks,
    deleteTask,
    addTask
};
