// Canvas scraper ported from canvas_scraper.py to Chrome extension context.
// Mirrors the Python logic (modules prefetch + BFS crawl + file streaming)
// while running inside the extension, using a fixed pool of background tabs
// and full-window restarts on hangs/timeouts.

class CanvasScraperPy {
    constructor() {
        this.START_URL = 'https://canvas.cornell.edu';
        this.COURSES_URL = `${this.START_URL}/courses`;

        this.ALLOWED_EXTENSIONS = [
            '.pdf', '.doc', '.docx', '.ppt', '.pptx',
            '.xls', '.xlsx', '.csv', '.txt', '.md', '.rtf'
        ];

        this.MAX_LINKS_PER_COURSE = 250;
        this.MIN_TEXT_LEN_TO_RECORD = 80;
        this.MAX_PAGE_CHARS = 50000;
        this.MAX_FILE_CHARS = 200000;

        this.workerPoolSize = 6;
        this.workerTabs = new Map(); // workerId -> { tabId, busy }
        this.availableWorkers = [];
        this.workerWaiters = [];

        this.scrapingInProgress = false;
        this.stopRequested = false;
        this.progressCallback = null;

        this.targetWindowId = null;
        this.keepAwakeInterval = null;

        this.courseStates = new Map(); // courseId -> { queue, visitedPages, visitedFiles, name, data }
        this.activeScrapes = [];

        this.restartInFlight = false;
        this.restartCourseId = null;
        this.restartReason = null;
        this.errorLog = [];
        this.syllabusOnlyMode = false;
        this.scrapedResults = {};
        this.discoveredLinks = new Set();
        this.scrapedCount = 0;
    }

    async startAutoScrape(progressCallback, windowId = null, syllabusOnlyMode = false) {
        if (this.scrapingInProgress) {
            console.log('[SCRAPER-PY] Scrape already running');
            return;
        }

        console.log('[SCRAPER-PY] Starting scrape');
        this.scrapingInProgress = true;
        this.stopRequested = false;
        this.progressCallback = progressCallback;
        this.syllabusOnlyMode = Boolean(syllabusOnlyMode);
        this.errorLog = [];
        this.courseStates.clear();
        this.restartInFlight = false;
        this.restartCourseId = null;
        this.restartReason = null;
        this.scrapedResults = {};
        this.discoveredLinks = new Set();
        this.scrapedCount = 0;
        this.sendProgress('Starting scrape...');

        this.startKeepAwake();

        try {
            if (windowId) {
                this.targetWindowId = windowId;
            } else {
                this.targetWindowId = await this.ensureScrapeWindow();
            }
            await this.initializeWorkerPool();

            let collectedCourseIds = null;

            while (!this.stopRequested) {
                if (!collectedCourseIds) {
                    collectedCourseIds = await this.collectCourseIds();
                    this.sendProgress(`Found ${collectedCourseIds.length} courses. Starting parallel scrape...`);
                }

                const idsToScrape = collectedCourseIds.filter(courseId => {
                    const state = this.courseStates.get(courseId);
                    return !(state && state.completed);
                });

                if (idsToScrape.length === 0) {
                    break;
                }

                this.activeScrapes = idsToScrape.map(courseId => this.scrapeCourse(courseId));
                const results = await Promise.allSettled(this.activeScrapes);

                const restartRequested = results.some(res => res.status === 'rejected' && res.reason?.isRestartRequested);
                if (restartRequested && !this.stopRequested) {
                    const restarted = await this.executeRestart();
                    if (!restarted || this.stopRequested) {
                        break;
                    }
                    continue;
                }

                break;
            }

            if (this.stopRequested) {
                this.sendProgress('✓ Scrape stopped by user');
            } else {
                this.sendProgress('✓ Scrape complete');
            }

            if (Object.keys(this.scrapedResults).length > 0) {
                await this.postProcessResults();
            } else {
                this.sendProgress('No course data collected.', { done: true });
            }
        } catch (error) {
            console.error('[SCRAPER-PY] Fatal error:', error);
            this.errorLog.push({ type: 'FATAL', message: error.message, stack: error.stack });
            this.sendProgress(`✗ Scrape failed: ${error.message}`, { done: true });
        } finally {
            this.scrapingInProgress = false;
            await this.cleanupWorkerTabs();
            this.stopKeepAwake();
        }
    }

    async stopScraping() {
        console.log('[SCRAPER-PY] Stop requested');
        this.stopRequested = true;
        await Promise.allSettled(this.activeScrapes);
        await this.cleanupWorkerTabs();
        await this.closeScrapeWindow();
        this.stopKeepAwake();
        this.scrapingInProgress = false;
        this.sendProgress('Scrape stopped', { done: true });
    }

    async scrapeCourse(courseId) {
        const state = this.createCourseState(courseId);
        try {
            await this.prefetchCourseName(state);
            await this.prefetchModuleFiles(state);
            await this.crawlCourse(state);
            this.scrapedResults[state.id] = state.data;
            state.completed = true;
            this.sendProgress(`✓ Course ${state.name} complete`);
            return state.data;
        } catch (error) {
            if (error.isRestartRequested) throw error;
            this.errorLog.push({
                type: 'COURSE_ERROR',
                courseId,
                message: error.message,
                stack: error.stack
            });
            console.error(`[SCRAPER-PY] Course ${courseId} failed:`, error);
            throw error;
        }
    }

    createCourseState(courseId) {
        if (this.courseStates.has(courseId)) {
            return this.courseStates.get(courseId);
        }
        const base = `${this.START_URL}/courses/${courseId}`;
        const seeds = [
            base,
            `${base}/assignments`,
            `${base}/modules`,
            `${base}/assignments/syllabus`,
            `${base}/grades`,
            `${base}/announcements`
        ];
        const state = {
            id: courseId,
            baseUrl: base,
            seeds,
            queue: [],
            visitedPages: new Set(),
            visitedFiles: new Set(),
            retryCounts: new Map(),
            fileRestartCounts: new Map(),
            completed: false,
            name: `Course ${courseId}`,
            data: {
                id: courseId,
                name: `Course ${courseId}`,
                pages: [],
                files: [],
                summary: [],
                scrapedAt: new Date().toISOString()
            }
        };
        this.courseStates.set(courseId, state);
        return state;
    }

    async prefetchCourseName(state) {
        const result = await this.executeOnWorker(state.baseUrl, async (ctx) => {
            await new Promise(resolve => {
                if (document.readyState === 'complete') resolve();
                else window.addEventListener('load', resolve);
            });
            let name = 'Course';
            try {
                const h1 = document.querySelector('h1');
                if (h1 && h1.textContent) {
                    name = h1.textContent.trim();
                } else {
                    name = document.title.trim();
                }
            } catch (e) {}
            return name;
        });

        if (result && typeof result === 'string') {
            const sanitized = this.sanitizeName(result);
            state.name = sanitized;
            state.data.name = sanitized;
            this.sendProgress(`📖 ${sanitized}`);
        }
    }

    async prefetchModuleFiles(state) {
        const moduleUrl = `${state.baseUrl}/modules`;
        this.sendProgress(`[${state.name}] Prefetching module files...`);

        try {
            const links = await this.executeOnWorker(moduleUrl, async (ctx) => {
                const allowed = ctx.allowedExtensions || [];
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const expandModules = async () => {
                    const toggles = document.querySelectorAll('button[aria-expanded="false"], .ig-header-collapse');
                    for (const toggle of toggles) {
                        try { toggle.click(); await sleep(120); } catch (e) {}
                    }
                    await sleep(300);
                };

                await new Promise(resolve => {
                    if (document.readyState === 'complete') resolve();
                    else window.addEventListener('load', resolve);
                });
                await sleep(600);
                await expandModules();

                const anchors = Array.from(document.querySelectorAll('a[href]'));
                const out = [];
                for (const anchor of anchors) {
                    const href = anchor.getAttribute('href') || '';
                    if (!href) continue;
                    const lower = href.toLowerCase();
                    const isFile = lower.includes('/files/') || allowed.some(ext => lower.endsWith(ext));
                    if (isFile) {
                        try {
                            const full = new URL(href, window.location.href).toString();
                            out.push(full);
                        } catch (e) {}
                    }
                }
                return Array.from(new Set(out));
            }, { allowedExtensions: this.ALLOWED_EXTENSIONS });

            if (Array.isArray(links)) {
                for (const link of links) {
                    if (this.stopRequested) break;
                    const normalized = this.normalizeCourseLink(link, state.id);
                    if (!normalized) continue;
                    if (state.visitedFiles.has(normalized)) continue;
                    this.trackDiscovery(normalized);
                    await this.scrapeFile(state, normalized);
                }
            }
        } catch (error) {
            console.warn(`[SCRAPER-PY] Prefetch modules failed for ${state.id}: ${error.message}`);
        }
    }

    async crawlCourse(state) {
        state.seeds.forEach(seed => {
            const normalized = this.normalizeCourseLink(seed, state.id);
            if (!normalized) return;
            if (this.syllabusOnlyMode && !normalized.toLowerCase().includes('syllabus')) return;
            if (!state.queue.includes(normalized)) {
                state.queue.push(normalized);
                this.trackDiscovery(normalized);
            }
        });

        this.sendProgress(`[${state.name}] BFS queue initialized (${state.queue.length})`);

        while (!this.stopRequested && state.queue.length > 0) {
            if (state.visitedPages.size >= this.MAX_LINKS_PER_COURSE) {
                console.log(`[SCRAPER-PY] Hit page cap for ${state.name}`);
                break;
            }

            if (this.restartInFlight && this.restartCourseId && this.restartCourseId !== state.id) {
                throw this.createRestartError();
            }

            const url = state.queue.shift();
            if (!url || state.visitedPages.has(url)) continue;

            if (this.syllabusOnlyMode && !url.toLowerCase().includes('syllabus')) {
                continue;
            }

            state.visitedPages.add(url);
            this.sendProgress(`[${state.name}] Visiting ${url}`, { notify: false });

            try {
                const pageData = await this.scrapePage(state, url);
                if (pageData && pageData.text && pageData.text.length >= this.MIN_TEXT_LEN_TO_RECORD) {
                    state.data.pages.push(pageData);
                    this.scrapedCount++;
                    this.sendProgress(`[${state.name}] Saved page (${pageData.text.length} chars): ${pageData.title || url}`, { notify: false });
                }

                if (pageData && Array.isArray(pageData.links)) {
                    for (const link of pageData.links) {
                        if (!link || !link.url) continue;
                        const normalized = this.normalizeCourseLink(link.url, state.id);
                        if (!normalized) continue;

                        if (this.isFileLink(normalized)) {
                            if (!state.visitedFiles.has(normalized)) {
                                this.trackDiscovery(normalized);
                                await this.scrapeFile(state, normalized);
                            }
                        } else {
                            if (this.syllabusOnlyMode && !normalized.toLowerCase().includes('syllabus')) {
                                continue;
                            }
                            if (!state.visitedPages.has(normalized) && !state.queue.includes(normalized)) {
                                state.queue.push(normalized);
                                this.trackDiscovery(normalized);
                            }
                        }
                    }
                }
            } catch (error) {
                if (error.isRestartRequested) throw error;
                console.warn(`[SCRAPER-PY] Error scraping ${url}: ${error.message}`);
            }

            await this.sleep(250);
        }
    }

    async scrapePage(state, url) {
        try {
            const result = await this.executeOnWorker(url, async (ctx) => {
                const maxChars = ctx.maxChars || 50000;
                const courseId = ctx.courseId;
                const allowed = ctx.allowedExtensions || [];

                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const expandAll = async () => {
                    const candidates = document.querySelectorAll(
                        '#expand_collapse_all, button[aria-label*="expand"], button[class*="expand"], .expand-collapse-all'
                    );
                    for (const btn of candidates) {
                        try { btn.click(); await sleep(150); } catch (e) {}
                    }
                    const details = document.querySelectorAll('details:not([open])');
                    for (const detail of details) {
                        try { detail.open = true; } catch (e) {}
                    }
                };

                const scrollToBottom = async () => {
                    let lastHeight = 0;
                    for (let i = 0; i < 20; i++) {
                        window.scrollTo(0, document.body.scrollHeight);
                        await sleep(300);
                        const height = document.body.scrollHeight;
                        if (height === lastHeight) break;
                        lastHeight = height;
                    }
                    window.scrollTo(0, 0);
                };

                const getText = () => {
                    try {
                        const body = document.body;
                        let text = body?.innerText || body?.textContent || '';
                        text = text.replace(/[ \t\r\f\v]+/g, ' ');
                        text = text.replace(/\n\s*\n+/g, '\n\n');
                        return text.trim();
                    } catch (e) {
                        return '';
                    }
                };

                const collectLinks = () => {
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    const out = [];
                    for (const anchor of anchors) {
                        try {
                            const href = new URL(anchor.href, window.location.href);
                            const host = (href.host || '').toLowerCase();
                            if (!host.includes('canvas.cornell.edu') && !host.includes('instructure.com')) continue;
                            const isFile = href.pathname.includes('/files/') || allowed.some(ext => href.pathname.toLowerCase().endsWith(ext));
                            out.push({ url: href.toString(), text: (anchor.textContent || '').trim(), isFile });
                        } catch (e) {}
                    }
                    return out;
                };

                await new Promise(resolve => {
                    if (document.readyState === 'complete') resolve();
                    else window.addEventListener('load', resolve);
                });
                await sleep(700);
                await expandAll();
                await scrollToBottom();

                const text = getText();
                const links = collectLinks();

                return {
                    type: 'page',
                    title: document.title || 'Untitled',
                    url: window.location.href,
                    text: text ? text.slice(0, maxChars) : '',
                    links,
                    metadata: {
                        courseId,
                        scrapedAt: new Date().toISOString()
                    }
                };
            }, {
                courseId: state.id,
                maxChars: this.MAX_PAGE_CHARS,
                allowedExtensions: this.ALLOWED_EXTENSIONS
            });

            return result;
        } catch (error) {
            if (error.message?.includes('Timeout waiting for page to load')) {
                await this.requestRestart(state.id, url, 'PAGE_TIMEOUT');
            }
            throw error;
        }
    }

    async scrapeFile(state, url) {
        const navigableUrl = this.getFilePreviewUrl(url);
        this.trackDiscovery(navigableUrl);
        if (state.visitedFiles.has(navigableUrl)) return;
        state.visitedFiles.add(navigableUrl);
        state.retryCounts.set(navigableUrl, 0);

        try {
            const result = await this.executeOnWorker(navigableUrl, async (ctx) => {
                const courseId = ctx.courseId;
                const maxChars = ctx.maxChars || 200000;
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                await new Promise(resolve => {
                    if (document.readyState === 'complete') resolve();
                    else window.addEventListener('load', resolve);
                });
                await sleep(800);

                const containers = document.querySelectorAll('.textLayer, .pdfViewer, .Pages, iframe');
                for (const container of containers) {
                    const target = container.contentDocument?.body || container;
                    if (!target) continue;
                    let last = 0;
                    for (let i = 0; i < 12; i++) {
                        target.scrollTop = target.scrollHeight;
                        await sleep(200);
                        const current = target.scrollTop;
                        if (current === last) break;
                        last = current;
                    }
                }

                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, nav, header, footer').forEach(el => el.remove());
                let text = (clone.innerText || '').replace(/\s+\n/g, '\n').trim();
                text = text.slice(0, maxChars);

                let filename = '';
                const title = document.querySelector('h1, h2');
                if (title && title.textContent) filename = title.textContent.trim();
                if (!filename) {
                    const path = new URL(window.location.href).pathname;
                    filename = path.split('/').pop() || 'file';
                }

                return {
                    type: 'file',
                    title: document.title || filename,
                    filename,
                    url: window.location.href,
                    text,
                    metadata: {
                        courseId,
                        scrapedAt: new Date().toISOString()
                    }
                };
            }, {
                courseId: state.id,
                maxChars: this.MAX_FILE_CHARS
            });

            if (result && result.text && result.text.length >= this.MIN_TEXT_LEN_TO_RECORD) {
                state.data.files.push(result);
                this.scrapedCount++;
                this.sendProgress(`[${state.name}] Saved file (${result.text.length} chars): ${result.filename}`, { notify: false });
            }
        } catch (error) {
            await this.handleFileError(state, url, navigableUrl, error);
        }
    }

    // ---------- Worker pool ----------

    async initializeWorkerPool() {
        await this.ensureScrapeWindow();
        while (this.workerTabs.size < this.workerPoolSize) {
            if (this.stopRequested) return;
            const workerId = `worker_${this.workerTabs.size + 1}`;
            const tabId = await this.createWorkerTab();
            this.workerTabs.set(workerId, { tabId, busy: false });
            this.availableWorkers.push(workerId);
            this.resolveNextWorkerWaiter();
        }
    }

    async createWorkerTab() {
        return await new Promise((resolve, reject) => {
            chrome.tabs.create({
                url: 'about:blank',
                windowId: this.targetWindowId,
                active: false
            }, (tab) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`Create worker tab failed: ${chrome.runtime.lastError.message}`));
                    return;
                }
                const tabId = tab.id;
                chrome.tabs.update(tabId, { autoDiscardable: false }, () => {
                    this.pingTab(tabId);
                    resolve(tabId);
                });
            });
        });
    }

    async executeOnWorker(url, script, context = {}) {
        if (this.stopRequested) throw new Error('Scrape stopped');
        const { workerId, tabId } = await this.acquireWorker();
        try {
            await this.navigateWorkerTab(workerId, url);
            const result = await this.runScriptOnTab(tabId, script, context);
            return result;
        } finally {
            this.releaseWorker(workerId);
        }
    }

    async acquireWorker() {
        await this.initializeWorkerPool();

        while (!this.stopRequested) {
            if (this.availableWorkers.length) {
                const workerId = this.availableWorkers.shift();
                const worker = this.workerTabs.get(workerId);
                if (!worker) continue;
                worker.busy = true;
                return { workerId, tabId: worker.tabId };
            }
            await new Promise(resolve => this.workerWaiters.push(resolve));
        }

        throw new Error('Scrape cancelled');
    }

    releaseWorker(workerId) {
        const worker = this.workerTabs.get(workerId);
        if (!worker) return;
        worker.busy = false;
        this.availableWorkers.push(workerId);
        this.resolveNextWorkerWaiter();
    }

    resolveNextWorkerWaiter() {
        const waiter = this.workerWaiters.shift();
        if (waiter) waiter();
    }

    async navigateWorkerTab(workerId, url) {
        const worker = this.workerTabs.get(workerId);
        if (!worker) throw new Error(`No worker: ${workerId}`);

        return await new Promise((resolve, reject) => {
            chrome.tabs.update(worker.tabId, { url, autoDiscardable: false }, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`Navigate worker failed: ${chrome.runtime.lastError.message}`));
                    return;
                }
                this.pingTab(worker.tabId);
                resolve();
            });
        });
    }

    async runScriptOnTab(tabId, script, context) {
        return await new Promise((resolve, reject) => {
            let resolved = false;

            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                }
            };

            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId !== tabId || changeInfo.status !== 'complete' || resolved) return;
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(async () => {
                    if (resolved) return;
                    try {
                        const result = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: script,
                            args: [context]
                        });
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            cleanup();
                            return;
                        }
                        resolve(result?.[0]?.result);
                        cleanup();
                    } catch (error) {
                        reject(error);
                        cleanup();
                    }
                }, 800);
            };

            chrome.tabs.onUpdated.addListener(listener);

            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    reject(new Error(chrome.runtime.lastError.message));
                    cleanup();
                    return;
                }
                if (tab.status === 'complete' && !resolved) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    setTimeout(async () => {
                        if (resolved) return;
                        try {
                            const result = await chrome.scripting.executeScript({
                                target: { tabId },
                                func: script,
                                args: [context]
                            });
                            resolve(result?.[0]?.result);
                            cleanup();
                        } catch (error) {
                            reject(error);
                            cleanup();
                        }
                    }, 800);
                }
            });

            setTimeout(() => {
                if (!resolved) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    const timeoutError = new Error(`Timeout waiting for page to load: ${context?.courseId || '?'} -> ${context?.url || ''}`);
                    timeoutError.isTimeout = true;
                    reject(timeoutError);
                    cleanup();
                }
            }, 60000);
        });
    }

    async cleanupWorkerTabs() {
        for (const worker of this.workerTabs.values()) {
            if (worker.tabId) {
                try { await chrome.tabs.remove(worker.tabId); } catch (e) {}
            }
        }
        this.workerTabs.clear();
        this.availableWorkers = [];
        this.workerWaiters.splice(0).forEach(resolve => resolve());
    }

    // ---------- Restart logic ----------

    async requestRestart(courseId, url, reason) {
        if (this.restartInFlight) {
            throw this.createRestartError();
        }
        console.warn('[SCRAPER-PY] Restart requested:', reason, url);
        this.restartInFlight = true;
        this.restartCourseId = courseId;
        this.restartReason = reason;
        const state = this.courseStates.get(courseId);
        const normalized = this.normalizeCourseLink(url, courseId) || url;
        if (state && normalized) {
            state.visitedPages.delete(normalized);
            state.visitedFiles.delete(normalized);
            state.completed = false;
            if (!state.queue.includes(normalized)) {
                state.queue.unshift(normalized);
            }
        }
        throw this.createRestartError();
    }

    createRestartError() {
        const error = new Error('RESTART_REQUIRED');
        error.isRestartRequested = true;
        error.courseId = this.restartCourseId;
        error.reason = this.restartReason;
        return error;
    }

    async executeRestart() {
        if (!this.restartInFlight) return;
        const courseId = this.restartCourseId;
        const reason = this.restartReason;
        this.sendProgress(`↻ Restarting due to ${reason || 'hang'}...`);

        await this.cleanupWorkerTabs();
        await this.closeScrapeWindow();

        this.restartInFlight = false;
        this.restartCourseId = null;
        this.restartReason = null;

        if (this.stopRequested) return false;

        this.targetWindowId = await this.ensureScrapeWindow(true);
        await this.initializeWorkerPool();

        return true;
    }

    async getScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['scrapedCanvasData'], (result) => {
                resolve(result.scrapedCanvasData || null);
            });
        });
    }

    async clearScrapedData() {
        this.scrapedResults = {};
        this.courseStates.clear();
        try {
            await chrome.storage.local.remove(['scrapedCanvasData']);
            console.log('[SCRAPER-PY] Cleared scraped data from storage');
        } catch (error) {
            console.error('[SCRAPER-PY] Error clearing scraped data:', error);
        }
    }

    async handleFileError(state, originalUrl, navigableUrl, error) {
        state.retryCounts = state.retryCounts || new Map();
        state.fileRestartCounts = state.fileRestartCounts || new Map();

        if (error.message?.includes('Timeout waiting for page to load')) {
            const currentRestarts = state.fileRestartCounts.get(navigableUrl) || 0;
            const maxRestarts = 4;
            if (currentRestarts >= maxRestarts) {
                state.visitedFiles.add(navigableUrl);
                this.sendProgress(`[${state.name}] File timeout: ${originalUrl} (giving up after ${maxRestarts} restarts)`);
                console.warn(`[SCRAPER-PY] File scrape timed out after ${maxRestarts} restarts ${originalUrl}`);
                return;
            }

            state.fileRestartCounts.set(navigableUrl, currentRestarts + 1);
            state.visitedFiles.delete(navigableUrl);
            state.retryCounts.delete(navigableUrl);

            this.sendProgress(`[${state.name}] File timeout: ${originalUrl} (restart ${currentRestarts + 1}/${maxRestarts})`);
            await this.requestRestart(state.id, navigableUrl, 'FILE_TIMEOUT');
            return;
        } else {
            this.sendProgress(`[${state.name}] File scrape failed: ${originalUrl} (${error.message})`);
            console.warn(`[SCRAPER-PY] File scrape failed (${originalUrl}): ${error.message}`);
        }
    }

    async postProcessResults() {
        if (!this.scrapedResults || Object.keys(this.scrapedResults).length === 0) {
            return;
        }
        this.sendProgress('Post-processing scraped data...');
        const rawSize = this.computeRawSize();
        this.sendProgress(`Uncompressed corpus size: ${rawSize.toLocaleString()} chars`);
        this.sendProgress('Removing HTML from corpus...');
        await this.removeHtmlFromCorpus();

        this.sendProgress('Restructuring corpus with GPT (per course)...');
        const { compressedSize } = await this.restructureCorpusWithGPT();
        this.sendProgress(`Compressed corpus size: ${compressedSize.toLocaleString()} chars`);

        this.sendProgress('Saving scraped data...');
        await this.saveScrapedData();
        this.sendProgress('✓ All done!', { done: true });
    }

    async removeHtmlFromCorpus() {
        const clean = (content) => {
            if (!content || typeof content !== 'string') return content;
            let cleaned = content.replace(/<[^>]*>/g, ' ');
            cleaned = cleaned.replace(/&[#\w]+;/g, ' ');
            cleaned = cleaned.replace(/\s+/g, ' ').trim();
            return cleaned;
        };

        for (const courseId in this.scrapedResults) {
            const course = this.scrapedResults[courseId];
            if (!course) continue;

            if (Array.isArray(course.pages)) {
                course.pages = course.pages.map(page => {
                    if (page && page.text) {
                        page.text = clean(page.text);
                    }
                    return page;
                });
            }

            if (Array.isArray(course.files)) {
                course.files = course.files.map(file => {
                    if (file && file.text) {
                        file.text = clean(file.text);
                    }
                    return file;
                });
            }
        }
    }

    formatCourseForGPT(courseId, course) {
        if (!course) return '';
        let corpus = `Course ID: ${courseId}\nCourse Name: ${course.name || 'Untitled Course'}\n\n`;

        if (Array.isArray(course.pages)) {
            for (const page of course.pages) {
                if (page && page.text) {
                    corpus += `--- PAGE: ${page.title || 'Untitled'} ---\nSource: ${page.url || 'Unknown'}\n${page.text}\n\n`;
                }
            }
        }

        if (Array.isArray(course.files)) {
            for (const file of course.files) {
                if (file && file.text) {
                    corpus += `--- FILE: ${file.filename || file.title || 'File'} ---\nSource: ${file.url || 'Unknown'}\n${file.text}\n\n`;
                }
            }
        }

        if (Array.isArray(course.summary)) {
            for (const note of course.summary) {
                if (note) {
                    corpus += `--- NOTE ---\n${note}\n\n`;
                }
            }
        }

        return corpus;
    }

    async processGPTSingleBatch(batchText, batchNumber, totalBatches, courseInfo = {}) {
        const openaiApiKey = await new Promise((resolve) => {
            chrome.storage.sync.get(['openaiApiKey'], (result) => {
                resolve(result.openaiApiKey || '');
            });
        });

        if (!openaiApiKey) {
            throw new Error('OpenAI API key not configured');
        }

        const courseHeader = courseInfo.courseName
            ? `Course: ${courseInfo.courseName} (ID: ${courseInfo.courseId || 'unknown'})`
            : '';

        const prompt = `You are an educational content cleaning assistant. Take the raw Canvas LMS text for a single course and clean it up: remove HTML artifacts, fix spacing, and produce clear sections that preserve ALL information.

PRIMARY GOAL: Clean the text while preserving every detail (assignments, dates, exams, readings, lectures, notes, policies, grades, etc.). Organize the output into logical sections for this course only.

CRITICAL CONTENT REQUIREMENTS - You MUST preserve and include ALL of the following for EACH course:
1. COMPLETE syllabus information
2. ALL assignments and problem sets (PSETS) with dates
3. ALL exam information with dates
4. ALL readings with summaries
5. ALL lecture information
6. ALL notes and supplementary materials
7. ALL dates for everything
8. Grade information
9. Course policies

OUTPUT FORMAT: Output clean, readable text organized by course.

OUTPUT LENGTH: Target approximately 480,000 characters (120,000 tokens) per batch.

${courseHeader ? `${courseHeader}\n\n` : ''}
--- CONTENT START ---
${batchText}
--- CONTENT END ---

Now clean the content above. Remove HTML artifacts and ensure all information (dates, assignments, readings, lecture notes, grades, policies, etc.) is preserved and well organized for this course.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiApiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5-nano',
                messages: [
                    { role: 'system', content: 'You are an educational content cleaning assistant. Remove HTML scraping artifacts and organize content by course. Preserve ALL syllabus, assignments, dates, exams, readings, lectures, notes, grades, and policies. Target ~480,000 characters per batch.' },
                    { role: 'user', content: prompt }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GPT API error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const restructured = data.choices[0].message.content.trim();

        const courseNameForLog = courseInfo.courseName || 'course';
        this.sendProgress(`GPT batch ${batchNumber}/${totalBatches} complete for ${courseNameForLog} (${restructured.length} chars)`);
        return restructured;
    }

    async restructureCourseWithGPT(courseId, course) {
        const courseText = this.formatCourseForGPT(courseId, course);
        if (!courseText || !courseText.trim()) {
            return '';
        }

        const charCount = courseText.length;
        const charsPerBatch = 400000 * 4;
        const batches = [];
        for (let i = 0; i < charCount; i += charsPerBatch) {
            batches.push(courseText.slice(i, i + charsPerBatch));
        }

        const restructuredBatches = [];
        for (let i = 0; i < batches.length; i++) {
            try {
                const restructured = await this.processGPTSingleBatch(
                    batches[i],
                    i + 1,
                    batches.length,
                    { courseId, courseName: course.name || courseId }
                );
                restructuredBatches.push(restructured);
                if (i < batches.length - 1) {
                    await this.sleep(1000);
                }
            } catch (error) {
                console.error(`[SCRAPER-PY] Error processing GPT batch ${i + 1} for ${course.name || courseId}:`, error);
                restructuredBatches.push(batches[i]);
            }
        }

        const combined = restructuredBatches.join('\n\n');
        course.compressedContext = combined;
        course.compressedLength = combined.length;
        this.sendProgress(`[${course.name || courseId}] Compressed from ${charCount.toLocaleString()} to ${combined.length.toLocaleString()} chars`);
        return combined;
    }

    async restructureCorpusWithGPT() {
        const sections = [];
        let totalCompressed = 0;

        for (const courseId in this.scrapedResults) {
            const course = this.scrapedResults[courseId];
            if (!course) continue;

            this.sendProgress(`Compressing course: ${course.name || courseId}`);
            const compressed = await this.restructureCourseWithGPT(courseId, course);
            if (!compressed) continue;

            sections.push(`=== COURSE: ${course.name || courseId} ===\n\n${compressed}`);
            totalCompressed += compressed.length;
        }

        const combinedText = sections.join('\n\n');
        this.scrapedResults._compressedContext = combinedText;
        return { combinedText, compressedSize: totalCompressed };
    }

    async saveScrapedData() {
        const dataToSave = {
            courses: this.scrapedResults,
            lastScraped: Date.now(),
            version: '1.0'
        };

        try {
            await chrome.storage.local.set({ scrapedCanvasData: dataToSave });
            console.log('[SCRAPER-PY] Saved scraped data to storage');
        } catch (error) {
            console.error('[SCRAPER-PY] Error saving scraped data:', error);
        }
    }

    computeRawSize() {
        let total = 0;
        for (const courseId in this.scrapedResults) {
            const course = this.scrapedResults[courseId];
            if (!course) continue;
            if (Array.isArray(course.pages)) {
                for (const page of course.pages) {
                    if (page && page.text) total += page.text.length;
                }
            }
            if (Array.isArray(course.files)) {
                for (const file of course.files) {
                    if (file && file.text) total += file.text.length;
                }
            }
            if (Array.isArray(course.summary)) {
                for (const note of course.summary) {
                    if (note) total += note.length;
                }
            }
        }
        return total;
    }

    // ---------- Helpers ----------

    async collectCourseIds() {
        this.sendProgress('Discovering courses...');
        try {
            const { fallIds = [], fallbackIds = [] } = await this.executeOnWorker(this.COURSES_URL, async () => {
                const result = { fallIds: [], fallbackIds: [] };
                const regex = /\/courses\/(\d+)/;
                const isFall2025 = (text) => {
                    if (!text) return false;
                    const lower = text.toLowerCase();
                    return lower.includes('fall') && lower.includes('2025');
                };

                await new Promise(resolve => setTimeout(resolve, 10000));

                const tables = Array.from(document.querySelectorAll('table'));
                tables.forEach(table => {
                    const headers = Array.from(table.querySelectorAll('thead th'));
                    const termIdx = headers.findIndex(th => (th.textContent || '').toLowerCase().includes('term'));
                    const rows = Array.from(table.querySelectorAll('tbody tr'));
                    rows.forEach(row => {
                        const link = row.querySelector('a[href*="/courses/"]:not([href*="/users/"])');
                        if (!link) return;
                        const href = link.getAttribute('href') || '';
                        const match = href.match(regex);
                        if (!match) return;
                        const courseId = match[1];

                        let termText = '';
                        if (termIdx >= 0) {
                            const cells = Array.from(row.querySelectorAll('td'));
                            if (cells[termIdx]) {
                                termText = (cells[termIdx].textContent || '').trim();
                            }
                        }
                        if (!termText) {
                            const termCells = Array.from(row.querySelectorAll('td'));
                            for (const cell of termCells) {
                                const txt = (cell.textContent || '').trim();
                                if (isFall2025(txt)) {
                                    termText = txt;
                                    break;
                                }
                            }
                        }

                        if (isFall2025(termText)) {
                            result.fallIds.push(courseId);
                        } else {
                            result.fallbackIds.push(courseId);
                        }
                    });
                });

                if (result.fallIds.length === 0) {
                    const anchors = Array.from(document.querySelectorAll('a[href*="/courses/"]'));
                    anchors.forEach(anchor => {
                        const href = anchor.getAttribute('href') || '';
                        const match = href.match(regex);
                        if (match) result.fallbackIds.push(match[1]);
                    });
                }

                result.fallIds = Array.from(new Set(result.fallIds));
                result.fallbackIds = Array.from(new Set(result.fallbackIds));
                return result;
            });

            const confirmed = new Set(fallIds);
            if (confirmed.size > 0) {
                return Array.from(confirmed);
            }

            let candidates = Array.from(new Set(fallbackIds));
            if (candidates.length === 0) {
                const dashboardCandidates = await this.executeOnWorker(this.START_URL, async () => {
                    const regex = /\/courses\/(\d+)/;
                    const ids = new Set();
                    await new Promise(resolve => {
                        if (document.readyState === 'complete') resolve();
                        else window.addEventListener('load', resolve);
                    });
                    const cards = Array.from(document.querySelectorAll('a[href*="/courses/"]'));
                    cards.forEach(card => {
                        const href = card.getAttribute('href') || '';
                        const match = href.match(regex);
                        if (match) ids.add(match[1]);
                    });
                    return Array.from(ids);
                });
                candidates = dashboardCandidates || [];
            }

            if (candidates.length > 0) {
                this.sendProgress(`Verifying term for ${candidates.length} course(s)...`);
            }

            const verified = [];
            for (const courseId of candidates) {
                if (await this.verifyCourseTerm(courseId)) {
                    verified.push(courseId);
                }
            }

            return verified;
        } catch (error) {
            console.warn('[SCRAPER-PY] Course discovery failed:', error.message);
            return [];
        }
    }

    async verifyCourseTerm(courseId) {
        try {
            const termText = await this.executeOnWorker(`${this.START_URL}/courses/${courseId}/settings`, async () => {
                await new Promise(resolve => {
                    if (document.readyState === 'complete') resolve();
                    else window.addEventListener('load', resolve);
                });

                const textContent = (element) => (element?.textContent || '').trim();
                const isFall2025 = (text) => {
                    if (!text) return false;
                    const lower = text.toLowerCase();
                    return lower.includes('fall') && lower.includes('2025');
                };

                let term = '';

                const ariaElement = Array.from(document.querySelectorAll('[aria-label], [aria-labelledby]')).find(el => {
                    const value = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-labelledby') || '')).toLowerCase();
                    return value.includes('term');
                });
                if (ariaElement) {
                    term = textContent(ariaElement);
                }

                if (!isFall2025(term)) {
                    const label = Array.from(document.querySelectorAll('label, div, span')).find(el => {
                        return textContent(el).toLowerCase().includes('term');
                    });
                    if (label) {
                        const next = label.nextElementSibling;
                        if (next) term = textContent(next);
                    }
                }

                if (!isFall2025(term)) {
                    const rows = Array.from(document.querySelectorAll('tr'));
                    for (const row of rows) {
                        const cells = Array.from(row.querySelectorAll('td, th'));
                        if (cells.length < 2) continue;
                        const header = textContent(cells[0]).toLowerCase();
                        if (header.includes('term')) {
                            term = textContent(cells[1]);
                            break;
                        }
                    }
                }

                return term;
            });

            if (!termText) return false;
            const lower = termText.toLowerCase();
            return lower.includes('fall') && lower.includes('2025');
        } catch (error) {
            console.warn(`[SCRAPER-PY] Could not verify term for course ${courseId}: ${error.message}`);
            return false;
        }
    }

    normalizeCourseLink(rawUrl, courseId) {
        if (!rawUrl) return null;
        try {
            const full = new URL(rawUrl, `${this.START_URL}/`);
            full.hash = '';
            const host = (full.host || '').toLowerCase();
            if (!host.includes('canvas.cornell.edu') && !host.includes('instructure.com')) return null;

            const path = full.pathname || '';
            const inCourse = path.startsWith(`/courses/${courseId}`) || path.includes(`/courses/${courseId}/`);
            const isFile = path.includes('/files/');
            if (!inCourse && !isFile) return null;

            const forbidden = ['/login', '/conversations', '/calendar', '/profile', '/settings/profile', '/settings/notifications'];
            if (forbidden.some(seg => path.includes(seg))) return null;

            if (isFile) {
                return this.getFilePreviewUrl(full.toString());
            }

            return full.toString();
        } catch (e) {
            return null;
        }
    }

    isFileLink(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        if (lower.includes('/files/') || lower.includes('/download')) return true;
        return this.ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
    }

    sanitizeName(name) {
        if (!name) return 'Course';
        return name.replace(/[^a-zA-Z0-9 _-]/g, '_').trim() || 'Course';
    }

    getFilePreviewUrl(url) {
        try {
            const parsed = new URL(url, `${this.START_URL}/`);
            if (parsed.pathname.includes('/files/') && parsed.pathname.includes('/download')) {
                parsed.pathname = parsed.pathname.replace(/\/download.*$/, '');
                parsed.search = 'preview=1';
                return parsed.toString();
            }
            if (parsed.pathname.includes('/files/') && !parsed.searchParams.has('preview')) {
                parsed.searchParams.set('preview', '1');
                return parsed.toString();
            }
            return parsed.toString();
        } catch (error) {
            return url;
        }
    }

    trackDiscovery(url) {
        if (!url) return;
        const normalized = url;
        if (!this.discoveredLinks.has(normalized)) {
            this.discoveredLinks.add(normalized);
            this.sendProgress(null);
        }
    }

    async ensureScrapeWindow(recreate = false) {
        if (!recreate && this.targetWindowId) {
            try {
                await new Promise((resolve, reject) => {
                    chrome.windows.get(this.targetWindowId, win => {
                        if (chrome.runtime.lastError || !win) reject(new Error('Window gone'));
                        else resolve();
                    });
                });
                return this.targetWindowId;
            } catch (e) {}
        }

        return await new Promise((resolve, reject) => {
            chrome.windows.create({
                url: `${this.START_URL}/`,
                focused: false,
                type: 'normal',
                width: 1000,
                height: 700
            }, (win) => {
                if (chrome.runtime.lastError || !win) {
                    reject(new Error(`Failed to create window: ${chrome.runtime.lastError?.message || 'unknown'}`));
                    return;
                }
                this.targetWindowId = win.id;
                chrome.tabs.query({ windowId: win.id }, (tabs) => {
                    tabs.forEach(tab => {
                        chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
                        this.pingTab(tab.id);
                    });
                });
                resolve(win.id);
            });
        });
    }

    async closeScrapeWindow() {
        if (!this.targetWindowId) return;
        try {
            const tabs = await new Promise(resolve => {
                chrome.tabs.query({ windowId: this.targetWindowId }, resolve);
            });
            if (Array.isArray(tabs)) {
                for (const tab of tabs) {
                    try {
                        await new Promise(resolve => chrome.tabs.remove(tab.id, resolve));
                    } catch (e) {}
                }
            }
            await new Promise(resolve => chrome.windows.remove(this.targetWindowId, resolve));
        } catch (e) {}
        this.targetWindowId = null;
    }

    sendProgress(message, extra = {}) {
        if (message) {
            console.log(`[SCRAPER-PY] ${message}`);
        }
        if (this.progressCallback) {
            const payload = {
                message: message || null,
                discovered: this.discoveredLinks.size,
                scraped: this.scrapedCount,
                ...extra
            };
            if (payload.notify === undefined) {
                payload.notify = true;
            }
            this.progressCallback(payload);
        }
    }

    startKeepAwake() {
        if (this.keepAwakeInterval) return;
        this.keepAwakeInterval = setInterval(() => {}, 25000);
    }

    stopKeepAwake() {
        if (this.keepAwakeInterval) {
            clearInterval(this.keepAwakeInterval);
            this.keepAwakeInterval = null;
        }
    }

    async pingTab(tabId) {
        try {
            await new Promise(resolve => {
                chrome.tabs.get(tabId, () => resolve());
            });
            chrome.tabs.sendMessage(tabId, { type: 'PING' }, () => {});
            chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
        } catch (e) {}
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

if (typeof self !== 'undefined') {
    self.CanvasScraperPy = CanvasScraperPy;
}
