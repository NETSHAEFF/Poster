const axios = require('axios');
const FormData = require('form-data');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const antiDetect = require('./anti-detect');

class Publisher {
    constructor(accountId = null, proxy = '') {
        this.accountId = accountId;
        this.proxy = proxy || '';
        this.cookie = '';
        this.accountName = null;
        this.uid = null;
        this.cachedApiKey = null;
        this.tokenExpiresAt = null;
        this.tokenRefreshPromise = null;
        this._updateAgents();
    }

    setAccountId(accountId) {
        this.accountId = accountId;
        this._updateAgents();
    }

    setProxy(proxy) {
        this.proxy = (proxy || '').trim();
        this._updateAgents();
    }

    setCookie(cookie) {
        if (this.cookie !== cookie) {
            this.cachedApiKey = null;
            this.tokenExpiresAt = null;
        }
        this.cookie = cookie;
    }

    _updateAgents() {
        const { httpsAgent, httpAgent } = antiDetect.createHttpAgents(this.proxy, this.accountId);
        this.httpsAgent = httpsAgent;
        this.httpAgent = httpAgent;
        this.client = axios.create({
            httpsAgent: this.httpsAgent,
            httpAgent: this.httpAgent,
            proxy: false, // Отключаем встроенный парсер прокси axios во избежание конфликтов
            timeout: config.requestTimeout
        });
    }

    getHeaders(options = {}) {
        return antiDetect.buildBrowserHeaders({
            accountId: this.accountId,
            cookie: this.cookie,
            origin: options.origin !== undefined ? options.origin : config.siteDomain,
            referer: options.referer !== undefined ? options.referer : config.siteDomain + '/',
            targetUrl: options.targetUrl || null,
            secFetchSite: options.secFetchSite || null,
            isAjax: !!options.isAjax,
            contentType: options.contentType || null,
            includeCookie: options.includeCookie !== undefined ? options.includeCookie : null
        });
    }

    _parseTokenPayload(token) {
        try {
            if (!token || typeof token !== 'string') return null;
            const parts = token.split('.');
            if (parts.length !== 2) return null;
            let b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        } catch (e) {
            return null;
        }
    }

    _isTokenValid(token, marginSeconds = 120) {
        if (!token) return false;
        const payload = this._parseTokenPayload(token);
        if (!payload || typeof payload.exp !== 'number') return false;
        return (payload.exp * 1000) > (Date.now() + marginSeconds * 1000);
    }

    async getFreshKey(forceRefresh = false) {
        if (!forceRefresh && this.cachedApiKey && this._isTokenValid(this.cachedApiKey, 120)) {
            return this.cachedApiKey;
        }

        if (this.tokenRefreshPromise) {
            return await this.tokenRefreshPromise;
        }

        this.tokenRefreshPromise = (async () => {
            // 1. Нативный эндпоинт реального клиента NameVids:
            // POST https://namevids.me/api/upload_token.php
            try {
                const tokenHeaders = this.getHeaders({
                    targetUrl: `${config.siteDomain}/api/upload_token.php`,
                    referer: `${config.siteDomain}/share`,
                    isAjax: true
                });
                tokenHeaders['Accept'] = 'application/json';

                const resp = await this.client.post(`${config.siteDomain}/api/upload_token.php`, null, {
                    headers: tokenHeaders,
                    timeout: config.requestTimeout
                });

                if (resp.data && resp.data.success && resp.data.key) {
                    this.cachedApiKey = resp.data.key;
                    if (resp.data.expires_at) {
                        this.tokenExpiresAt = resp.data.expires_at;
                    }
                    return this.cachedApiKey;
                }

                const respStr = typeof resp.data === 'object' ? JSON.stringify(resp.data) : String(resp.data || '');
                if (respStr.includes('Account suspended') || resp.data?.error === 'Account suspended' || resp.data?.code === 'ACCOUNT_SUSPENDED') {
                    throw new Error('Account suspended');
                }
            } catch (tokenErr) {
                if (tokenErr.message && tokenErr.message.includes('Account suspended')) {
                    throw tokenErr;
                }
            }

            // 2. Fallback: парсинг /share
            const shareHeaders = this.getHeaders({
                targetUrl: `${config.siteDomain}/share`,
                referer: `${config.siteDomain}/`,
                isAjax: false
            });

            const resp = await this.client.get(`${config.siteDomain}/share`, {
                headers: shareHeaders,
                timeout: config.requestTimeout
            });

            const html = String(resp.data || '');
            if (html.includes('Account suspended') && !html.includes('style="display: none;"')) {
                if (html.includes('status-message') && !html.includes('style="display: none;"')) {
                    throw new Error('Account suspended');
                }
            }

            const match = html.match(/apiKey:\s*['"]([^'"]+)['"]/);
            if (match && match[1]) {
                this.cachedApiKey = match[1];
                return this.cachedApiKey;
            }

            if (html.includes('Account suspended')) {
                throw new Error('Account suspended');
            }

            throw new Error('apiKey не найден. Проверьте Cookie!');
        })();

        try {
            const key = await this.tokenRefreshPromise;
            if (key) {
                const payload = this._parseTokenPayload(key);
                if (payload && payload.uid) {
                    this.uid = String(payload.uid);
                }
            }
            return key;
        } finally {
            this.tokenRefreshPromise = null;
        }
    }

    async uploadFile(filePath, apiKey, originalName) {
        const targetUrl = `${config.apiDomain}/api/upload.php`;
        const boundary = antiDetect.generateWebKitBoundary();
        const form = new FormData();
        form.setBoundary(boundary);

        const stream = fs.createReadStream(filePath);
        const filename = antiDetect.generateNaturalFilename(originalName || filePath);
        form.append('file', stream, { filename });
        form.append('key', apiKey);

        const formHeaders = form.getHeaders();
        const length = await new Promise((resolve, reject) => {
            form.getLength((err, l) => {
                if (err) reject(err);
                else resolve(l);
            });
        });

        // Запрос к oakroot.top является cross-site:
        // Sec-Fetch-Site: cross-site, Origin: https://namevids.me, без Cookie!
        const headers = {
            ...this.getHeaders({
                targetUrl,
                origin: config.siteDomain,
                referer: `${config.siteDomain}/share`,
                isAjax: true
            }),
            ...formHeaders,
            'Content-Length': length
        };

        const resp = await this.client.post(targetUrl, form, {
            headers,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: config.requestTimeout
        });

        if (resp.data && resp.data.error) {
            if (String(resp.data.error).includes('Account suspended')) {
                this.cachedApiKey = null;
                throw new Error('Account suspended');
            }
        }

        return resp.data;
    }

    async saveMetadata(fileId, apiKey, metadata, isVideo) {
        const targetUrl = `${config.apiDomain}/api/share.php`;
        // Сохраняем переносы строк, схлопывая только лишние горизонтальные пробелы
        const caption = (metadata.caption || '')
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        const title = (metadata.title || '').replace(/\s+/g, ' ').trim();

        const params = new URLSearchParams();
        if (isVideo) {
            params.append('title', title);
        }
        params.append('caption', caption);
        params.append('fileId', String(fileId));
        params.append('key', apiKey);

        logger.info(`📝 saveMetadata: isVideo=${isVideo}, title="${title}", caption="${caption.substring(0, 50)}...", fileId=${fileId}`);

        const headers = this.getHeaders({
            targetUrl,
            origin: config.siteDomain,
            referer: `${config.siteDomain}/share`,
            isAjax: true,
            contentType: 'application/x-www-form-urlencoded'
        });

        const resp = await this.client.post(targetUrl, params.toString(), {
            headers,
            timeout: config.requestTimeout
        });

        logger.info(`📝 saveMetadata response: ${JSON.stringify(resp.data)}`);

        if (resp.data && resp.data.error) {
            if (String(resp.data.error).includes('Account suspended')) {
                this.cachedApiKey = null;
                throw new Error('Account suspended');
            }
            throw new Error(`Ошибка сохранения метаданных: ${resp.data.error}`);
        }
    }

    async publish(apiKey) {
        const targetUrl = `${config.apiDomain}/api/share.php`;
        // Реальный браузер NameVids отправляет share="1" (share=1&key=...), а НЕ share=true!
        const params = new URLSearchParams({
            share: '1',
            key: apiKey
        });

        const headers = this.getHeaders({
            targetUrl,
            origin: config.siteDomain,
            referer: `${config.siteDomain}/share`,
            isAjax: true,
            contentType: 'application/x-www-form-urlencoded'
        });

        const resp = await this.client.post(targetUrl, params.toString(), {
            headers,
            timeout: config.requestTimeout
        });

        const respStr = typeof resp.data === 'object' ? JSON.stringify(resp.data) : String(resp.data || '');
        logger.info(`🚀 publish response: ${respStr}`);

        if (respStr.toLowerCase().includes('posting too fast')) {
            logger.warn(`⚠️ Внимание: Ограничение скорости! "You are posting too fast. Try again later."`);
            throw new Error('You are posting too fast. Try again later.');
        }

        if (respStr.includes('Account suspended') || (resp.data && resp.data.error === 'Account suspended')) {
            this.cachedApiKey = null;
            throw new Error('Account suspended');
        }

        if (resp.data && resp.data.error) {
            throw new Error(`Ошибка публикации: ${resp.data.error}`);
        }

        return resp.data;
    }

    async getStats() {
        if (!this.cookie) return { views: 0, subs: 0 };
        try {
            if (!this.uid) {
                const respShare = await this.client.get(`${config.siteDomain}/share`, {
                    headers: this.getHeaders()
                });
                const $ = cheerio.load(respShare.data);
                const accountName = $('.FooterTop-Login').text().trim();
                if (accountName) {
                    this.accountName = accountName;
                }

                let foundUid = null;
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && href.includes('/@')) {
                        const match = href.match(/-(\d+)\/?$/);
                        if (match) foundUid = match[1];
                    }
                });

                if (foundUid) {
                    this.uid = foundUid;
                } else if (this.accountName) {
                    try {
                        const profileUrl = `${config.siteDomain}/@${encodeURIComponent(this.accountName.toLowerCase())}`;
                        const respProfile = await this.client.get(profileUrl, { headers: this.getHeaders() });
                        const matchUid = respProfile.data.match(/uid\s*=\s*['"]?(\d+)['"]?/i);
                        if (matchUid) this.uid = matchUid[1];
                    } catch(e) {}
                }
            }

            if (!this.uid) return { views: 0, subs: 0 };

            const payload = new URLSearchParams();
            payload.append('redact', 'userstatistics');
            payload.append('id', 'false');
            payload.append('uid', this.uid);

            const resp = await this.client.post(`${config.siteDomain}/api/get_chart_uid.php`, payload.toString(), {
                headers: this.getHeaders({
                    isAjax: true,
                    contentType: 'application/x-www-form-urlencoded'
                }),
                timeout: config.requestTimeout
            });

            let views = 0, subs = 0;
            const dataObj = resp.data || {};
            const html = dataObj.data || '';
            const js = dataObj.js || '';

            const $stat = cheerio.load(html);
            const subsText = $stat('.stat').text();
            if (subsText) subs = parseInt(subsText.replace(/\D/g, '')) || 0;

            const viewsMatch = js.match(/data:\s*\[([\d,\s]+)\]/s);
            if (viewsMatch) {
                const dataArr = viewsMatch[1].split(',').map(s => parseInt(s.trim()));
                views = dataArr[dataArr.length - 1] || 0;
            }

            return { views, subs };
        } catch (e) {
            return null;
        }
    }

    isVideoFile(fileName) {
        return config.videoExtensions.includes(path.extname(fileName).toLowerCase());
    }

    isValidFile(fileName) {
        return config.allowedExtensions.includes(path.extname(fileName).toLowerCase());
    }

    async updateContent(fileId, { title, description }) {
        if (!this.cookie) throw new Error('Cookie не установлена');
        if (!fileId) throw new Error('fileId не указан');

        const results = {};
        const headers = this.getHeaders({
            isAjax: true,
            contentType: 'application/x-www-form-urlencoded'
        });

        if (title !== undefined && title !== null) {
            const cleanTitle = String(title).replace(/\s+/g, ' ').trim().slice(0, 70);
            const payload = `text=${encodeURIComponent(cleanTitle)}&type=title&fileid=${encodeURIComponent(fileId)}`;
            const resp = await this.client.post(`${config.siteDomain}/api/redact_content.php`, payload, {
                headers,
                timeout: config.requestTimeout
            });
            if (resp.data && resp.data.type === 'savecontent-error') {
                throw new Error(resp.data.text || resp.data.msg || 'Ошибка сохранения заголовка');
            }
            results.title = resp.data;
        }

        if (description !== undefined && description !== null) {
            const cleanDesc = String(description)
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
                .slice(0, 200);
            const payload = `text=${encodeURIComponent(cleanDesc)}&type=description&fileid=${encodeURIComponent(fileId)}`;
            const resp = await this.client.post(`${config.siteDomain}/api/redact_content.php`, payload, {
                headers,
                timeout: config.requestTimeout
            });
            if (resp.data && resp.data.type === 'savecontent-error') {
                throw new Error(resp.data.text || resp.data.msg || 'Ошибка сохранения описания');
            }
            results.description = resp.data;
        }

        return results;
    }

    async getProfileMedia(accountName, options = {}) {
        const name = (accountName || this.accountName || '').trim();
        if (!name) return [];

        const { page = null, maxPages = 50, concurrency = 4 } = options;

        if (page !== null && page !== undefined && !isNaN(page) && page > 0) {
            try {
                const url = `${config.siteDomain}/@${encodeURIComponent(name.toLowerCase())}?page=${page}`;
                const resp = await this.client.get(url, {
                    headers: this.getHeaders(),
                    timeout: config.requestTimeout
                });
                const $ = cheerio.load(resp.data);
                const items = [];
                $('a.boxpost').each((i, el) => {
                    const fileId = $(el).attr('id');
                    const href = $(el).attr('href');
                    const title = $(el).find('.description .cut').text().trim();
                    const time = $(el).find('.time').text().trim();
                    const views = $(el).find('.meter .num').text().trim();
                    if (fileId) {
                        items.push({
                            fileId: String(fileId),
                            href: href || '',
                            title: title || '',
                            time: time || '',
                            views: views ? parseInt(views.replace(/\D/g, '')) || 0 : 0
                        });
                    }
                });
                return items;
            } catch (e) {
                logger.warn(`[getProfileMedia] Ошибка загрузки страницы ${page} профиля @${name}: ${e.message}`);
                return [];
            }
        }

        const items = [];
        const seenIds = new Set();
        let currentPage = 1;

        try {
            while (currentPage <= maxPages) {
                const pageNumbers = [];
                for (let i = 0; i < concurrency && currentPage <= maxPages; i++, currentPage++) {
                    pageNumbers.push(currentPage);
                }

                const pagePromises = pageNumbers.map(p => {
                    const url = `${config.siteDomain}/@${encodeURIComponent(name.toLowerCase())}?page=${p}`;
                    return this.client.get(url, {
                        headers: this.getHeaders(),
                        timeout: config.requestTimeout
                    }).then(resp => ({ page: p, data: resp.data }))
                      .catch(err => ({ page: p, error: err }));
                });

                const results = await Promise.all(pagePromises);
                let hasEnd = false;

                for (const res of results) {
                    if (res.error || !res.data) {
                        hasEnd = true;
                        break;
                    }

                    const $ = cheerio.load(res.data);
                    const pagePosts = $('a.boxpost');

                    pagePosts.each((i, el) => {
                        const fileId = $(el).attr('id');
                        const href = $(el).attr('href');
                        const title = $(el).find('.description .cut').text().trim();
                        const time = $(el).find('.time').text().trim();
                        const views = $(el).find('.meter .num').text().trim();
                        if (fileId && !seenIds.has(String(fileId))) {
                            seenIds.add(String(fileId));
                            items.push({
                                fileId: String(fileId),
                                href: href || '',
                                title: title || '',
                                time: time || '',
                                views: views ? parseInt(views.replace(/\D/g, '')) || 0 : 0
                            });
                        }
                    });

                    if (pagePosts.length < 52) {
                        hasEnd = true;
                        break;
                    }
                }

                if (hasEnd) break;
            }

            return items;
        } catch (e) {
            logger.warn(`[getProfileMedia] Ошибка при обходе страниц профиля @${name}: ${e.message}`);
            return items;
        }
    }

    async getVideoDetails(hrefOrId) {
        try {
            const url = String(hrefOrId).startsWith('http')
                ? hrefOrId
                : String(hrefOrId).startsWith('/')
                    ? `${config.siteDomain}${hrefOrId}`
                    : `${config.siteDomain}/${hrefOrId}`;
            const resp = await this.client.get(url, {
                headers: this.getHeaders(),
                timeout: config.requestTimeout
            });
            const $ = cheerio.load(resp.data);
            const title = $('h1#title').text().trim();
            const description = $('div#description').text().trim();
            const matchFileId = resp.data.match(/fileid\s*=\s*['"]?(\d+)['"]?/i);
            const fileId = matchFileId ? matchFileId[1] : null;
            return {
                title,
                description,
                fileId
            };
        } catch (e) {
            return null;
        }
    }
}

module.exports = Publisher;
