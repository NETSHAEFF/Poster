const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('./config');
const { testWarmCookie, startWarmUp, stopWarmUp, isWarmRunning, WARM_VIDEOS_NEEDED } = require('./warm-up');
const multer = require('multer');
const mediaEditor = require('./media-editor');
const antiDetect = require('./anti-detect');
const { shortenUrl } = require('./url-shortener');

module.exports = function(app, ctx) {
    const {
        accounts, runtime, logger, upload,
        UPLOAD_DIR, ENV_FILE, MAX_ACCOUNTS, db,
        getFullState, getAccountState, updateStats,
        startPublishingLoop, clearQueueCache, setAction,
        saveAccounts, createDefaultAccount, initAccountRuntime,
        downloader = ctx.downloader || require('./downloader'),
        modifier = ctx.modifier,
        torManager = ctx.torManager || require('./tor-manager'),
    } = ctx;

    app.get('/api/events', async (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        const state = await getFullState();
        res.write(`data: ${JSON.stringify({ type: 'init', data: { state, logs: logger.getRecentLogs() } })}\n\n`);
        logger.addClient(res);
        req.on('close', () => logger.removeClient(res));
    });

    app.get('/api/state', async (req, res) => res.json(await getFullState()));

    app.post('/api/accounts', async (req, res) => {
        if (accounts.length >= MAX_ACCOUNTS) {
            return res.status(400).json({ error: `Максимум ${MAX_ACCOUNTS} аккаунтов` });
        }
        const maxId = accounts.reduce((max, a) => Math.max(max, a.id), 0);
        const newAcc = createDefaultAccount(maxId + 1);
        accounts.push(newAcc);
        initAccountRuntime(newAcc);
        await saveAccounts();
        logger.info(`➕ Добавлен: ${newAcc.name}`);
        logger.broadcastState(await getFullState());
        res.json({ success: true, account: await getAccountState(newAcc.id) });
    });

    app.delete('/api/accounts/:id', async (req, res) => {
        const id = parseInt(req.params.id);
        const idx = accounts.findIndex(a => a.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Аккаунт не найден' });
        if (accounts.length <= 1) return res.status(400).json({ error: 'Нельзя удалить последний аккаунт' });
        if (runtime[id] && runtime[id].isRunning) {
            return res.status(400).json({ error: 'Остановите аккаунт перед удалением' });
        }
        const name = accounts[idx].name;
        accounts.splice(idx, 1);
        delete runtime[id];
        await db.deleteAccount(id);
        logger.info(`🗑️ Удалён: ${name}`);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/accounts/:id/name', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Пустое имя' });
        acc.name = name.trim();
        await saveAccounts();
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/accounts/:id/cookie', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
        const { cookie } = req.body;
        if (!cookie) return res.status(400).json({ error: 'Cookie пуста' });
        acc.cookie = cookie;
        runtime[id].publisher.setCookie(cookie);
        await saveAccounts();
        logger.success(`[${acc.name}] Cookie обновлена`);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/accounts/:id/proxy', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
        const { proxy } = req.body;
        acc.proxy = (proxy || '').trim();
        if (runtime[id] && runtime[id].publisher) {
            runtime[id].publisher.setProxy(acc.proxy);
        }
        await saveAccounts();
        const masked = acc.proxy ? acc.proxy.replace(/:\/\/.*@/, '://***@') : 'без прокси';
        logger.info(`[${acc.name}] Прокси обновлен: ${masked}`);
        logger.broadcastState(await getFullState());
        res.json({ success: true, proxy: acc.proxy });
    });

    app.post('/api/accounts/:id/test-proxy', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
        const proxy = ((req.body && req.body.proxy !== undefined) ? req.body.proxy : acc.proxy || '').trim();
        if (!proxy) return res.json({ success: true, message: 'Прокси не задан (прямое подключение)' });
        try {
            const { httpsAgent } = antiDetect.createHttpAgents(proxy, acc.id);
            const resp = await axios.get('https://api.ipify.org?format=json', {
                headers: {
                    'User-Agent': antiDetect.getBrowserProfile(acc.id).userAgent
                },
                httpsAgent,
                proxy: false,
                timeout: 10000
            });
            res.json({ success: true, ip: resp.data.ip });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // Ротация и назначение свежего Tor-маршрута (нового IP) для аккаунта
    app.post('/api/accounts/:id/auto-proxy', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });

        try {
            const workingProxy = torManager.rotateCircuit(id);
            acc.proxy = workingProxy;
            if (runtime[id] && runtime[id].publisher) {
                runtime[id].publisher.setProxy(workingProxy);
            }
            await saveAccounts();
            logger.success(`[${acc.name}] 🧅 Назначен новый Tor-маршрут (Circuit): ${workingProxy}`);
            logger.broadcastState(await getFullState());
            res.json({ success: true, proxy: workingProxy });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Назначить изолированные Tor-маршруты всем аккаунтам
    app.post('/api/proxies/auto-assign-all', async (req, res) => {
        const results = [];
        for (const acc of accounts) {
            try {
                const newProxy = torManager.rotateCircuit(acc.id);
                acc.proxy = newProxy;
                if (runtime[acc.id] && runtime[acc.id].publisher) {
                    runtime[acc.id].publisher.setProxy(newProxy);
                }
                results.push({ accountId: acc.id, name: acc.name, proxy: newProxy });
            } catch (e) {
                results.push({ accountId: acc.id, name: acc.name, error: e.message });
            }
        }

        await saveAccounts();
        logger.broadcastState(await getFullState());
        res.json({ success: true, assignments: results });
    });

    // Получить статус сети Tor
    app.get('/api/tor/status', async (req, res) => {
        try {
            const stats = await torManager.getStats(accounts);
            res.json({ success: true, stats });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Совместимость со старым эндпоинтом статистики прокси
    app.get('/api/proxies/stats', async (req, res) => {
        try {
            const stats = await torManager.getStats(accounts);
            res.json({ success: true, stats });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Смена Tor-маршрута при запросе бана
    app.post('/api/proxies/ban', async (req, res) => {
        const { proxy, accountId } = req.body || {};
        if (accountId) {
            const newProxy = torManager.rotateCircuit(accountId);
            logger.broadcastState(await getFullState());
            res.json({ success: true, message: 'Сформирован новый Tor-маршрут', proxy: newProxy });
        } else {
            res.json({ success: true, message: 'Маршрут обновлен' });
        }
    });

    // Получить список заблокированных прокси
    app.get('/api/proxies/banned', async (req, res) => {
        try {
            const banned = await db.getBannedProxies();
            res.json({ success: true, banned });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/accounts/:id/test-cookie', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        const rt = runtime[id];
        if (!acc || !rt) return res.status(404).json({ error: 'Аккаунт не найден' });

        try {
            const resp = await rt.publisher.client.get(`${config.siteDomain}/share`, {
                headers: rt.publisher.getHeaders(),
                timeout: config.requestTimeout
            });
            const html = String(resp.data || '');
            if (html.includes('Account suspended')) {
                return res.json({ success: false, error: 'Аккаунт заблокирован (Account suspended)' });
            }
            const $ = cheerio.load(html);

            const keyMatch = html.match(/apiKey:\s*['"]([^'"]+)['"]/);
            if (!keyMatch || !keyMatch[1]) {
                return res.json({ success: false, error: 'apiKey не найден. Cookie невалидна.' });
            }

            const accountName = $('.FooterTop-Login').text().trim() || html.match(/FooterTop-Login[^>]*>([^<]+)/)?.[1] || 'Неизвестно';
            
            if (accountName.toLowerCase() === 'log in' || accountName === 'Неизвестно') {
                return res.json({ success: false, error: 'Cookie устарела или невалидна (требуется вход)' });
            }

            rt.publisher.accountName = accountName;
            
            // Всегда обновляем имя аккаунта в базе на актуальное с сайта
            acc.name = accountName;
            await saveAccounts();

            await updateStats(id);
            res.json({ success: true, accountName });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    app.get('/api/global-metadata', async (req, res) => {
        try {
            const meta = await db.getGlobalMetadata();
            res.json(meta);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/global-metadata', async (req, res) => {
        try {
            const { title, caption, tgLink, randomMode, watermark } = req.body;
            const meta = {
                title: title !== undefined ? title : '',
                caption: caption !== undefined ? caption : '',
                tgLink: tgLink !== undefined ? tgLink : '',
                randomMode: randomMode !== undefined ? randomMode : true,
                watermark: watermark || { enabled: false, text: '@ТвойКанал', fontSize: 36, color: 'white', bordercolor: 'black', borderwidth: 2, position: 'bottom-right' }
            };
            await db.saveGlobalMetadata(meta);
            logger.broadcastState(await getFullState());
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/accounts/:id/start', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        const rt = runtime[id];
        if (!acc || !rt) return res.status(404).json({ error: 'Аккаунт не найден' });
        if (rt.isRunning) return res.json({ success: false, error: 'Уже запущен' });
        acc.delayMinutes = (req.body && parseFloat(req.body.delay)) || acc.delayMinutes || config.defaultDelay;
        await saveAccounts();
        rt.isRunning = true;
        startPublishingLoop(id);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/accounts/:id/stop', async (req, res) => {
        const id = parseInt(req.params.id);
        const rt = runtime[id];
        if (!rt) return res.status(404).json({ error: 'Аккаунт не найден' });
        rt.isRunning = false;
        await setAction(id, 'Остановка...');
        res.json({ success: true });
    });

    app.post('/api/start-all', async (req, res) => {
        for (const acc of accounts) {
            const rt = runtime[acc.id];
            if (rt && !rt.isRunning && acc.cookie) {
                rt.isRunning = true;
                startPublishingLoop(acc.id);
            }
        }
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/stop-all', async (req, res) => {
        for (const acc of accounts) {
            const rt = runtime[acc.id];
            if (rt && rt.isRunning) {
                rt.isRunning = false;
                await setAction(acc.id, 'Остановка...');
            }
        }
        res.json({ success: true });
    });

    app.post('/api/upload-files', upload.array('files', 50), async (req, res) => {
        if (!req.files || !req.files.length) return res.status(400).json({ error: 'Нет файлов' });
        clearQueueCache();
        logger.info(`📁 Загружено ${req.files.length} файл(ов) в очередь`);
        logger.broadcastState(await getFullState());
        res.json({ success: true, count: req.files.length });
    });

    app.delete('/api/queue/:fileName', async (req, res) => {
        const fp = path.join(UPLOAD_DIR, req.params.fileName);
        if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Не найден' });
        fs.unlinkSync(fp);
        clearQueueCache();
        logger.info(`🗑️ Удалён: ${req.params.fileName}`);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/accounts/:id/history/clear', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
        await db.clearAccountHistory(id);
        clearQueueCache(id);
        logger.info(`🧹 История публикаций аккаунта ${acc.name} очищена`);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/history/clear-all', async (req, res) => {
        await db.clearAllHistory();
        clearQueueCache();
        logger.info('♻️ Вся история публикаций сброшена для всех аккаунтов');
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/reserve-cookies', async (req, res) => {
        const { cookies } = req.body;
        if (!cookies || !Array.isArray(cookies)) return res.status(400).json({ error: 'Invalid data' });
        
        await db.addReserveCookies(cookies);
        logger.success(`🍪 Добавлено резервных Cookie: ${cookies.length}`);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    // --- Warm-up API ---

    app.get('/api/warm-accounts', async (req, res) => {
        const accounts = await db.getWarmAccounts();
        const warmCount = await db.getWarmAccountsCount();
        res.json({ accounts, warmCount });
    });

    app.post('/api/warm-accounts', async (req, res) => {
        const { cookie } = req.body;
        if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie пуста' });

        // Test the cookie first
        const test = await testWarmCookie(cookie.trim());
        if (!test.success) {
            return res.json({ success: false, error: test.error });
        }

        const id = await db.addWarmAccount(cookie.trim());
        if (!id) return res.status(400).json({ error: 'Cookie уже добавлена на прогрев' });

        await db.updateWarmAccount(id, { account_name: test.accountName });
        logger.info(`🔥 Аккаунт добавлен на прогрев: ${test.accountName}`);
        logger.broadcastState(await getFullState());

        // Start warm-up immediately
        startWarmUp(id);

        res.json({ success: true, accountName: test.accountName, id });
    });

    app.post('/api/warm-accounts/:id/start', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = await db.getWarmAccount(id);
        if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
        if (isWarmRunning(id)) return res.json({ success: false, error: 'Уже запущен' });
        startWarmUp(id);
        res.json({ success: true });
    });

    app.post('/api/warm-accounts/:id/stop', async (req, res) => {
        const id = parseInt(req.params.id);
        stopWarmUp(id);
        res.json({ success: true });
    });

    app.delete('/api/warm-accounts/:id', async (req, res) => {
        const id = parseInt(req.params.id);
        stopWarmUp(id);
        await db.deleteWarmAccount(id);
        logger.info(`🗑️ Аккаунт на прогреве #${id} удалён`);
        res.json({ success: true });
    });

    // --- Gemini API key settings ---

    app.get('/api/settings/gemini-key', (req, res) => {
        const key = process.env.GEMINI_API_KEY || '';
        res.json({ hasKey: !!key, keyPreview: key ? key.substring(0, 8) + '...' : '' });
    });

    app.post('/api/settings/gemini-key', (req, res) => {
        const { key } = req.body;
        if (!key || !key.trim()) return res.status(400).json({ error: 'Ключ пуст' });
        
        // Update runtime env
        process.env.GEMINI_API_KEY = key.trim();

        // Persist to .env file
        try {
            let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
            if (envContent.includes('GEMINI_API_KEY=')) {
                envContent = envContent.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${key.trim()}`);
            } else {
                envContent = envContent.trimEnd() + `\nGEMINI_API_KEY=${key.trim()}\n`;
            }
            fs.writeFileSync(ENV_FILE, envContent, 'utf8');
            logger.success('🤖 Gemini API ключ сохранён');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Не удалось сохранить в .env: ' + e.message });
        }
    });

    // --- AutoCopy (TData converter) API ---

    const autocopy = require('./autocopy');
    const autocopyStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            let baseDir = path.join(__dirname, '..');
            if (process.pkg) baseDir = path.dirname(process.execPath);
            const dir = path.join(baseDir, 'temp');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + '_' + Math.random().toString(36).substring(2, 7) + '_' + Buffer.from(file.originalname, 'latin1').toString('utf8'));
        }
    });

    const autocopyUpload = multer({
        storage: autocopyStorage,
        limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (ext === '.zip') {
                cb(null, true);
            } else {
                cb(new Error('Только .zip архивы поддерживаются'), false);
            }
        }
    });

    app.get('/api/autocopy/tasks', (req, res) => {
        res.json({ tasks: autocopy.getTasks() });
    });

    app.post('/api/autocopy/upload', autocopyUpload.array('files', 50), async (req, res) => {
        if (!req.files || !req.files.length) return res.status(400).json({ error: 'Файлы не загружены' });
        
        for (const file of req.files) {
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            await autocopy.addTask(originalName, file.size, file.path, getFullState);
        }
        
        logger.broadcastState(await getFullState());
        res.json({ success: true, count: req.files.length });
    });

    app.post('/api/autocopy/clear', async (req, res) => {
        autocopy.clearTasks();
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.delete('/api/autocopy/tasks/:id', async (req, res) => {
        autocopy.deleteTask(req.params.id);
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    // --- Published Media & Editor API ---
    app.get('/api/accounts/:id/published', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        const rt = runtime[id];
        if (!acc || !rt) return res.status(404).json({ error: 'Аккаунт не найден' });

        try {
            const page = req.query.page ? parseInt(req.query.page) : null;
            // 1. Fetch live items from profile page (single page or all pages)
            const profileItems = await rt.publisher.getProfileMedia(acc.name, { page });

            // 2. Fetch history items from database
            const dbItems = await db.getPublishedFiles(id);

            // 3. Merge: profileItems first, then add any dbItems not yet in list
            const seenIds = new Set(profileItems.map(p => String(p.fileId)));
            const merged = [...profileItems];

            for (const d of dbItems) {
                if (!seenIds.has(String(d.fileId))) {
                    seenIds.add(String(d.fileId));
                    merged.push({
                        fileId: String(d.fileId),
                        href: '',
                        title: d.fileName || `Файл ${d.fileId}`,
                        time: '',
                        views: 0,
                        fileName: d.fileName,
                        timestamp: d.timestamp
                    });
                }
            }

            res.json({ success: true, items: merged });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/accounts/:id/published/:fileId/details', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        const rt = runtime[id];
        if (!acc || !rt) return res.status(404).json({ error: 'Аккаунт не найден' });

        const fileId = req.params.fileId;
        const href = req.query.href;

        try {
            const details = await rt.publisher.getVideoDetails(href || fileId);
            res.json({ success: true, details: details || { title: '', description: '', fileId } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/accounts/:id/published/:fileId', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        const rt = runtime[id];
        if (!acc || !rt) return res.status(404).json({ error: 'Аккаунт не найден' });

        const fileId = req.params.fileId;
        const { title, description } = req.body;

        try {
            const result = await rt.publisher.updateContent(fileId, { title, description });
            logger.success(`[${acc.name}] Обновлены метаданные файла #${fileId}`);
            res.json({ success: true, result });
        } catch (err) {
            logger.error(`[${acc.name}] Ошибка обновления #${fileId}: ${err.message}`);
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/accounts/:id/published-batch', async (req, res) => {
        const id = parseInt(req.params.id);
        const acc = accounts.find(a => a.id === id);
        const rt = runtime[id];
        if (!acc || !rt) return res.status(404).json({ error: 'Аккаунт не найден' });

        const { items, title, description, updateTitle, updateDesc, delaySeconds } = req.body;

        try {
            const task = await mediaEditor.startBatchUpdate({
                accountId: id,
                accountName: acc.name,
                publisher: rt.publisher,
                items,
                title,
                description,
                updateTitle: !!updateTitle,
                updateDesc: !!updateDesc,
                delaySeconds: parseFloat(delaySeconds) || 2
            });
            res.json({ success: true, task });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/accounts/:id/published-batch/stop', (req, res) => {
        const id = parseInt(req.params.id);
        const stopped = mediaEditor.stopBatchUpdate(id);
        res.json({ success: true, stopped });
    });

    app.get('/api/accounts/:id/published-batch/status', (req, res) => {
        const id = parseInt(req.params.id);
        res.json({ success: true, status: mediaEditor.getBatchStatus(id) });
    });

    // --- Downloader (DwFromNv) API ---
    app.get('/api/downloader/state', (req, res) => {
        res.json({ success: true, state: downloader.getState() });
    });

    app.get('/api/downloader/proxy', (req, res) => {
        res.json({ success: true, proxy: downloader.getProxy() });
    });

    app.post('/api/downloader/proxy', async (req, res) => {
        try {
            const { proxy } = req.body || {};
            const cleanProxy = String(proxy || '').trim();
            downloader.setProxy(cleanProxy);
            await db.saveDownloaderProxy(cleanProxy);
            logger.info(`🌐 Загрузчик: режим сети изменён на: ${cleanProxy ? cleanProxy : 'Прямое подключение (без прокси)'}`);
            res.json({ success: true, proxy: cleanProxy });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/downloader/search', async (req, res) => {
        try {
            const { category, maxCount, minViews, minDuration, maxDuration, page, depth } = req.body || {};
            const result = await downloader.fetchVideos({
                category,
                maxCount,
                minViews,
                minDuration,
                maxDuration,
                page,
                depth
            });
            const videos = Array.isArray(result) ? result : (result.videos || []);
            res.json({
                success: true,
                videos,
                page: result.page || parseInt(page, 10) || 1,
                depth: result.depth || parseInt(depth, 10) || 1,
                pagesScanned: result.pagesScanned || 1,
                hasMore: result.hasMore !== undefined ? result.hasMore : true
            });
        } catch (e) {
            logger.error(`Ошибка поиска видео Namevids: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/downloader/resolve', async (req, res) => {
        try {
            const { url } = req.body || {};
            if (!url) return res.status(400).json({ error: 'Укажите URL или ID' });
            const vidId = await downloader.resolveVideoId(url);
            res.json({ success: true, videoId: vidId });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/downloader/download', async (req, res) => {
        try {
            const { items, destination = 'uploads' } = req.body || {};
            if (!items || !Array.isArray(items) || !items.length) {
                return res.status(400).json({ error: 'Список видео для скачивания пуст' });
            }

            const added = downloader.addTasks(items, destination, async () => {
                logger.broadcastState(await getFullState());
            });

            logger.info(`📥 Загрузчик: добавлено в очередь ${added.length} видео (в папку: ${destination})`);
            logger.broadcastState(await getFullState());
            res.json({ success: true, count: added.length, tasks: added });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/downloader/stop', async (req, res) => {
        downloader.stopDownload(async () => {
            logger.broadcastState(await getFullState());
        });
        logger.warn('⏹ Загрузчик: скачивание остановлено пользователем');
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.post('/api/downloader/clear-finished', async (req, res) => {
        downloader.clearFinishedTasks(async () => {
            logger.broadcastState(await getFullState());
        });
        logger.broadcastState(await getFullState());
        res.json({ success: true });
    });

    app.get('/api/downloader/files', (req, res) => {
        const dest = req.query.dest || 'downloads';
        res.json({ success: true, files: downloader.getLocalFiles(dest) });
    });

    app.post('/api/downloader/open-folder', (req, res) => {
        const { dest = 'downloads' } = req.body || {};
        downloader.openFolder(dest);
        res.json({ success: true });
    });

    app.post('/api/downloader/clear-folder', async (req, res) => {
        try {
            const { dest = 'downloads' } = req.body || {};
            const count = downloader.clearFolder(dest);
            if (dest === 'uploads') {
                clearQueueCache();
            }
            const folderName = dest === 'uploads' ? 'uploads' : 'DwFromNv/downloads';
            logger.info(`🗑️ Папка ${folderName} очищена (удалено файлов: ${count})`);
            logger.broadcastState(await getFullState());
            res.json({ success: true, count, dest });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/downloader/delete-file', async (req, res) => {
        try {
            const { dest = 'downloads', fileName } = req.body || {};
            if (!fileName) return res.status(400).json({ error: 'Укажите имя файла' });
            const success = downloader.deleteFile(dest, fileName);
            if (dest === 'uploads') {
                clearQueueCache();
            }
            if (success) {
                logger.info(`🗑️ Удален файл ${fileName} из папки ${dest}`);
                logger.broadcastState(await getFullState());
                res.json({ success: true });
            } else {
                res.status(404).json({ error: 'Файл не найден' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- System Control ---
    app.post('/api/system/clear-temp', (req, res) => {
        try {
            if (modifier && typeof modifier.cleanupAll === 'function') {
                modifier.cleanupAll();
            }
            logger.info('🧹 Временные файлы ffmpeg/unique очищены');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/test-shortener', async (req, res) => {
        try {
            const { url } = req.body || {};
            if (!url) return res.status(400).json({ error: 'Укажите URL для сокращения' });
            const shortened = await shortenUrl(url);
            res.json({ success: true, original: url, shortened });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/system/shutdown', (req, res) => {
        logger.warn('🛑 Получена команда на завершение работы скрипта...');
        res.json({ success: true, message: 'Скрипт завершает работу' });
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    });

    app.post('/api/system/restart', (req, res) => {
        const { spawn } = require('child_process');
        logger.warn('🔄 Получена команда на перезапуск скрипта...');
        res.json({ success: true, message: 'Скрипт перезапускается' });

        setTimeout(() => {
            const rootDir = path.resolve(__dirname, '..');
            const targetArgs = process.pkg ? [] : [path.join(rootDir, 'server.js')];
            const targetCwd = process.pkg ? path.dirname(process.execPath) : rootDir;

            const child = spawn(process.execPath, targetArgs, {
                detached: true,
                stdio: 'ignore',
                cwd: targetCwd,
                windowsHide: true
            });
            child.unref();
            process.exit(0);
        }, 1000);
    });
};

