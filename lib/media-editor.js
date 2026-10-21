const logger = require('./logger');

const batchTasks = {};

function sleep(ms, checkStop) {
    const end = Date.now() + ms;
    return new Promise(resolve => {
        const interval = setInterval(() => {
            if (Date.now() >= end || (checkStop && checkStop())) {
                clearInterval(interval);
                resolve();
            }
        }, 200);
    });
}

function getBatchStatus(accountId) {
    return batchTasks[accountId] || {
        isRunning: false,
        stopRequested: false,
        total: 0,
        processed: 0,
        successCount: 0,
        errorCount: 0,
        currentFile: '',
        errors: []
    };
}

function stopBatchUpdate(accountId) {
    if (batchTasks[accountId] && batchTasks[accountId].isRunning) {
        batchTasks[accountId].stopRequested = true;
        logger.warn(`[BatchEdit] Запрошена остановка пакетного обновления для аккаунта #${accountId}`);
        return true;
    }
    return false;
}

async function startBatchUpdate({
    accountId,
    accountName,
    publisher,
    items,
    title,
    description,
    updateTitle = true,
    updateDesc = true,
    delaySeconds = 2
}) {
    if (batchTasks[accountId] && batchTasks[accountId].isRunning) {
        throw new Error('Пакетное обновление для этого аккаунта уже запущено');
    }

    if (!items || !items.length) {
        throw new Error('Список файлов для обновления пуст');
    }

    const task = {
        isRunning: true,
        stopRequested: false,
        total: items.length,
        processed: 0,
        successCount: 0,
        errorCount: 0,
        currentFile: '',
        errors: [],
        startTime: Date.now()
    };
    batchTasks[accountId] = task;

    logger.info(`✏️ [${accountName}] Запуск пакетного обновления ${items.length} медиафайлов (задержка ${delaySeconds}с)...`);

    // Run in background so request returns immediately
    (async () => {
        try {
            for (let i = 0; i < items.length; i++) {
                if (task.stopRequested) {
                    logger.warn(`⏹️ [${accountName}] Пакетное обновление прервано пользователем (${task.processed}/${task.total})`);
                    break;
                }

                const item = items[i];
                const fileId = item.fileId || item;
                const fileLabel = item.title ? `[${fileId}] "${item.title}"` : `[${fileId}]`;
                task.currentFile = fileLabel;

                const payload = {};
                if (updateTitle && title !== undefined && title !== null && title.trim() !== '') {
                    payload.title = title.trim();
                }
                if (updateDesc && description !== undefined && description !== null && description.trim() !== '') {
                    payload.description = description.trim();
                }

                try {
                    await publisher.updateContent(fileId, payload);
                    task.successCount++;
                    logger.success(`✅ [${accountName}] [${i + 1}/${items.length}] Обновлено: ${fileLabel}`);
                } catch (err) {
                    task.errorCount++;
                    task.errors.push({ fileId, error: err.message });
                    logger.error(`❌ [${accountName}] [${i + 1}/${items.length}] Ошибка обновления ${fileLabel}: ${err.message}`);
                }

                task.processed = i + 1;

                if (i < items.length - 1 && !task.stopRequested) {
                    await sleep(delaySeconds * 1000, () => task.stopRequested);
                }
            }

            logger.info(`🏁 [${accountName}] Пакетное обновление завершено: успешно ${task.successCount}, ошибок ${task.errorCount}`);
        } catch (fatalErr) {
            logger.error(`💥 [${accountName}] Сбой пакетного обновления: ${fatalErr.message}`);
        } finally {
            task.isRunning = false;
            task.currentFile = '';
        }
    })();

    return task;
}

module.exports = {
    startBatchUpdate,
    stopBatchUpdate,
    getBatchStatus
};
