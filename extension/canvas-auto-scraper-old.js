// Canvas Auto-Scraper Old - Rewritten with scraper-core.js, utils.js, and pdf-extractor.js logic
// Adapted for Chrome extension with parallelization, syllabus-only mode, and separate window
// NO RAG - stores compressed GPT context to pass directly to GPT-5-nano for chat

class CanvasAutoScraperOld {
    constructor() {
        this.scrapingInProgress = false;
        this.coursesData = {};
        this.targetWindowId = null;
        this.keepAwakeInterval = null;
        this.stopRequested = false;
        this.activeScrapingPromises = [];
        
        // Courses to skip
        this.excludedCourseIds = [
            '14918', '14901', '45845', '40187', '46043'
        ];
        
        this.syllabusOnlyMode = false;
        
        // Restart tracking
        this.needsRestart = false;
        this.restartReason = null;
        this.restartCourseId = null;
        this.restartFileUrl = null;
        this.restartInProgress = false;
        
        // Error logging
        this.errorLog = [];
        this.scrapingStartTime = null;
        this.activeOperations = new Map();
        
        // Constants
        this.START_URL = "https://canvas.cornell.edu";
        this.scrapedUrls = new Set();
        this.MAX_LINKS_PER_COURSE = 250;
        this.MIN_TEXT_LEN_TO_RECORD = 80;
        this.MAX_PAGE_CHARS = 50000;
        this.MAX_FILE_CHARS = 200000;
        
        // Tab management - worker pool (shared tabs across courses)
        this.workerPoolSize = 6;
        this.workerTabs = new Map(); // workerId -> { tabId, busy: boolean, courseId: string | null }
        this.availableWorkers = [];
        this.workerWaiters = [];
        
        // Per-course scraping state (enables true parallelization)
        this.courseScrapingState = new Map(); // courseId -> { visitedPages: Set, visitedFiles: Set, queue: [] }
        
        // Keep-alive mechanism
        this.keepAliveAlarmName = 'scraperKeepAlive';
        this.keepAliveInterval = null;
        this.keepAliveListener = null;
    }
    
    // ===== INFRASTRUCTURE METHODS (KEPT FROM ORIGINAL) =====
    
    async stopScraping() {
        console.log('[SCRAPER-OLD] Stop requested by user');
        this.stopRequested = true;
        
        // Stop keep-alive mechanism
        this.stopKeepAlive();
        
        if (this.targetWindowId) {
            try {
                const tabs = await new Promise((resolve) => {
                    chrome.tabs.query({windowId: this.targetWindowId}, resolve);
                });
                for (const tab of tabs) {
                    try {
                        await chrome.tabs.remove(tab.id);
                    } catch (e) {}
                }
            } catch (e) {}
        }
        
        if (this.activeScrapingPromises.length > 0) {
            await Promise.allSettled(this.activeScrapingPromises);
        }
        
        this.sendProgress('✓ Scraping stopped by user. Processing collected data...');
    }
    
    async startAutoScrape(progressCallback, windowId = null, syllabusOnlyMode = false) {
        if (this.scrapingInProgress) {
            console.log('Scraping already in progress');
            return;
        }

        console.log('[SCRAPER-OLD] Starting automated Canvas scrape...');
        this.scrapingInProgress = true;
        this.stopRequested = false;
        this.syllabusOnlyMode = syllabusOnlyMode;
        this.progressCallback = progressCallback;
        this.targetWindowId = windowId;
        this.scrapingStartTime = Date.now();
        this.errorLog = [];
        this.activeOperations.clear();
        this.resetRestartState();
        this.courseScrapingState.clear(); // Clear per-course state
        await this.cleanupWorkerTabs();

        this.startKeepAwake();
        this.startKeepAlive(); // Start keep-alive mechanism

        try {
            // Step 1: Get course IDs from dashboard
            this.sendProgress('Discovering courses on dashboard...');
            const courseIds = await this.getDashboardCourseIds();
            console.log(`[SCRAPER-OLD] Found ${courseIds.length} courses: ${courseIds}`);

            if (courseIds.length === 0) {
                console.log('[SCRAPER-OLD] No courses found');
                this.sendProgress('No courses found');
                await this.saveScrapedData();
                return;
            }

            this.sendProgress(`Found ${courseIds.length} courses. Starting parallel scrape...`);

            // Step 2: Scrape all courses in parallel with restart handling
            const totalCourses = courseIds.length;
            let pendingCourseIds = [...courseIds];
            let iteration = 0;

            const initialCompleted = Object.values(this.coursesData).filter(course => course?.fullyCompleted).length;
            this.sendProgress(`progress:${initialCompleted}/${totalCourses}`);

            while (pendingCourseIds.length > 0 && !this.stopRequested) {
                iteration++;
                this.stopRequested = false;
                this.activeScrapingPromises = [];

                const courseScrapingPromises = pendingCourseIds.map((courseId) => {
                    const operationId = `course_${courseId}_${Date.now()}`;
                    this.activeOperations.set(operationId, `Scraping course ${courseId} (iteration ${iteration})`);

                    const promise = (async () => {
                        const courseContext = {
                            courseId: courseId,
                            courseName: null,
                            completedCourses: 0,
                            totalCourses: totalCourses
                        };

                        try {
                            console.log(`[SCRAPER-OLD] [Course ${courseId}] 🚀 Starting parallel scrape (iteration ${iteration})...`);

                            this.currentCourseContext = courseContext;

                            await this.scrapeCourse(courseId);

                            console.log(`[SCRAPER-OLD] [Course ${courseId}] ✅ Completed scraping`);
                            return 'SUCCESS';
                        } catch (error) {
                            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                                console.error(`[SCRAPER-OLD] [Course ${courseId}] ⚠️ Restart required`);
                                throw error;
                            }

                            this.logDetailedError({
                                errorType: 'COURSE_SCRAPING_ERROR',
                                errorMessage: error.message || 'Unknown error',
                                errorStack: error.stack,
                                courseId: courseId,
                                courseName: this.coursesData[courseId]?.name,
                                operation: 'scrapeCourse',
                                currentPhase: 'course_scraping'
                            });

                            console.error(`[SCRAPER-OLD] [Course ${courseId}] ❌ Error: ${error.message}`);
                            return 'ERROR';
                        } finally {
                            this.activeOperations.delete(operationId);

                            const completedCount = Object.values(this.coursesData).filter(course => course?.fullyCompleted).length;
                            this.sendProgress(`progress:${completedCount}/${totalCourses}`);

                            if (this.currentCourseContext?.courseId === courseId) {
                                this.currentCourseContext = null;
                            }
                        }
                    })();

                    this.activeScrapingPromises.push(promise);
                    return promise;
                });

                const results = await Promise.allSettled(courseScrapingPromises);

                const restartResult = results.find(result => result.status === 'rejected' && result.reason?.isRestartRequired);
                if (restartResult) {
                    console.log('[SCRAPER-OLD] Restart detected after timeout. Preparing to resume...');

                    pendingCourseIds = pendingCourseIds.filter(courseId => !this.coursesData[courseId]?.fullyCompleted);
                    if (this.restartCourseId && !pendingCourseIds.includes(this.restartCourseId)) {
                        pendingCourseIds.push(this.restartCourseId);
                    }

                    if (!this.targetWindowId) {
                        this.targetWindowId = await this.ensureScrapingWindow();
                    }

                    this.resetRestartState();
                    continue;
                }

                // Remove completed courses from pending list
                pendingCourseIds = pendingCourseIds.filter(courseId => !this.coursesData[courseId]?.fullyCompleted);

                if (pendingCourseIds.length > 0) {
                    console.warn(`[SCRAPER-OLD] ${pendingCourseIds.length} course(s) remain incomplete after iteration ${iteration}.`);
                }

                break;
            }

            this.resetRestartState();
            
            if (this.stopRequested) {
                this.sendProgress('✓ Scraping stopped. Processing collected data...');
            } else {
                this.sendProgress('✓ Scraping complete! Processing data...');
            }

            // Step 3: Post-process scraped data
            console.log('[SCRAPER-OLD] Post-processing scraped data...');
            this.sendProgress('Post-processing scraped data...');

            this.sendProgress('Removing HTML from corpus...');
            await this.removeHtmlFromCorpus();

            // Step 4: Process with GPT
            this.sendProgress('Restructuring corpus with GPT...');
            await this.restructureCorpusWithGPT();

            // Step 5: Save to storage
            await this.saveScrapedData();

            this.sendProgress('✓ All done!');
            console.log('[SCRAPER-OLD] Scraping complete');

        } catch (error) {
            console.error('[SCRAPER-OLD] Error during auto-scrape:', error);
            this.sendProgress(`✗ Error: ${error.message}`);
        } finally {
            this.scrapingInProgress = false;
            this.stopKeepAwake();
            this.stopKeepAlive(); // Stop keep-alive mechanism
        }
    }

    // Get course IDs from dashboard (KEPT - works well)
    async getDashboardCourseIds() {
        console.log('[SCRAPER-OLD] Getting course IDs from dashboard...');

        const allCourseIds = await this.executeScriptOnPage('https://canvas.cornell.edu/', () => {
            // Wait for courses to load (from scraper-core.js getAllCourses)
            const waitStart = Date.now();
            while (Date.now() - waitStart < 10000) {
                const courseLinks = document.querySelectorAll('a[href*="/courses/"]');
                if (courseLinks.length > 0) break;
                const checkStart = Date.now();
                while (Date.now() - checkStart < 100) {}
            }
            
            const courseIds = new Set();
            const courseSelectors = [
                'a[href*="/courses/"]',
                '[class*="course-card"] a',
                '[class*="ic-DashboardCard"] a'
            ];
            
            for (const selector of courseSelectors) {
                const links = document.querySelectorAll(selector);
                for (const link of links) {
                    const href = link.href;
                    if (href && href.includes('/courses/') && !href.includes('/courses?')) {
                        const match = href.match(/\/courses\/(\d+)/);
                        if (match && match[1]) {
                            courseIds.add(match[1]);
                        }
                    }
                }
            }
            
            return Array.from(courseIds);
        }, 1);

        const filteredCourseIds = allCourseIds.filter(courseId => 
            !this.excludedCourseIds.includes(courseId)
        );

        const excludedCount = allCourseIds.length - filteredCourseIds.length;
        if (excludedCount > 0) {
            console.log(`[SCRAPER-OLD] Excluded ${excludedCount} course(s)`);
        }

        console.log(`[SCRAPER-OLD] Proceeding with ${filteredCourseIds.length} course(s)`);
        return filteredCourseIds;
    }

    // ===== NEW SCRAPING LOGIC (FROM scraper-core.js) =====
    
    // Scrape a single course (REWRITTEN using scraper-core.js logic)
    async scrapeCourse(courseId) {
        if (this.excludedCourseIds.includes(courseId)) {
            console.log(`[SCRAPER-OLD] [Course ${courseId}] ⏭️ Skipping excluded course`);
            return;
        }

        console.log(`[SCRAPER-OLD] [Course ${courseId}] 📚 Starting course scrape...`);

        const baseUrl = `${this.START_URL}/courses/${courseId}`;

        if (this.restartInProgress && this.restartCourseId && this.restartCourseId !== courseId) {
            throw this.createRestartError();
        }

        // Initialize course data
        if (!this.coursesData[courseId]) {
            this.coursesData[courseId] = {
                id: courseId,
                name: `Course ${courseId}`,
                scrapedAt: Date.now(),
                pages: [],
                files: [],
                metadata: {},
                summary: []
            };
        } else {
            this.coursesData[courseId].scrapedAt = Date.now();
            this.coursesData[courseId].pages = this.coursesData[courseId].pages || [];
            this.coursesData[courseId].files = this.coursesData[courseId].files || [];
        }

        if (!this.courseScrapingState.has(courseId)) {
            this.courseScrapingState.set(courseId, {
                visitedPages: new Set(),
                visitedFiles: new Set(),
                queue: [],
                courseName: `Course ${courseId}`
            });
        }

        const courseState = this.courseScrapingState.get(courseId);

        try {
            const courseInfo = await this.getCourseInfo(courseId, baseUrl);
            const courseName = courseInfo.name || `Course ${courseId}`;
            this.coursesData[courseId].name = courseName;
            courseState.courseName = courseName;

            if (this.currentCourseContext) {
                this.currentCourseContext.courseName = courseName;
            }

            console.log(`[SCRAPER-OLD] [Course ${courseId}] 📖 Course name: ${courseName}`);

            if (this.stopRequested) return;

            await this.prefetchModuleFiles(courseId, baseUrl, courseState);

            if (this.stopRequested) return;

            await this.crawlCourse(courseId, baseUrl, courseState);

            this.coursesData[courseId].fullyCompleted = true;
            this.coursesData[courseId].completedAt = Date.now();

            console.log(`[SCRAPER-OLD] [Course ${courseId}] ✅ Completed course`);
        } catch (error) {
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }

            this.logDetailedError({
                errorType: 'COURSE_SCRAPING_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                operation: 'scrapeCourse',
                currentPhase: 'course_scraping'
            });
        }
    }

    // Get course info (name, etc.)
    async getCourseInfo(courseId, baseUrl) {
        try {
            const info = await this.executeScriptOnPage(baseUrl, (context) => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {}
                
                let name = 'Unknown Course';
                try {
                    const h1 = document.querySelector('h1');
                    if (h1 && h1.textContent) {
                        name = h1.textContent.trim();
                    } else {
                        name = document.title.trim();
                    }
                } catch (e) {}
                
                return { name: name || `Course ${courseId}` };
            }, 1, { courseId: courseId }); // Pass courseId explicitly for parallel execution
            
            return info || { name: `Course ${courseId}` };
        } catch (e) {
            return { name: `Course ${courseId}` };
        }
    }



    // ===== UTILITY FUNCTIONS ADAPTED FROM canvas_scraper.py =====

    sanitizeName(name) {
        if (!name) return 'Course';
        return name.replace(/[^a-zA-Z0-9 _-]/g, '_').trim() || 'Course';
    }

    normalizeCourseLink(rawUrl, courseId) {
        if (!rawUrl) return null;
        try {
            const fullUrl = new URL(rawUrl, `${this.START_URL}/`);
            const host = (fullUrl.host || '').toLowerCase();
            if (!host.includes('canvas.cornell.edu') && !host.includes('instructure.com')) {
                return null;
            }

            fullUrl.hash = '';

            const path = fullUrl.pathname || '';
            const inCourse = path.startsWith(`/courses/${courseId}`) || path.includes(`/courses/${courseId}/`);
            const isFile = path.includes('/files/');
            if (!inCourse && !isFile) {
                return null;
            }

            const forbidden = ['/login', '/conversations', '/calendar', '/profile', '/settings/profile', '/settings/notifications'];
            if (forbidden.some(segment => path.includes(segment))) {
                return null;
            }

            return fullUrl.toString();
        } catch (error) {
            return null;
        }
    }

    buildCourseSeeds(courseId) {
        const base = `${this.START_URL}/courses/${courseId}`;
        return [
            base,
            `${base}/assignments`,
            `${base}/modules`,
            `${base}/assignments/syllabus`,
            `${base}/grades`,
            `${base}/announcements`
        ];
    }

    isAllowedFileExtension(url) {
        const lower = url.toLowerCase();
        const extensions = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.rtf'];
        return extensions.some(ext => lower.endsWith(ext));
    }

    isFileLink(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        return lower.includes('/files/') || lower.includes('/download') || this.isAllowedFileExtension(lower);
    }

    capText(text, maxChars) {
        if (!text) return '';
        return maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    addSeedToQueue(courseState, url) {
        if (!url) return;
        if (!courseState.queue.includes(url)) {
            courseState.queue.push(url);
        }
    }

    storePageContent(courseId, pageData) {
        if (!pageData || !pageData.text) return;
        const trimmed = (pageData.text || '').trim();
        if (trimmed.length < this.MIN_TEXT_LEN_TO_RECORD) return;

        this.coursesData[courseId].pages.push({
            title: pageData.title || 'Untitled Page',
            url: pageData.url,
            text: this.capText(trimmed, this.MAX_PAGE_CHARS),
            metadata: pageData.metadata || {}
        });
    }

    storeFileContent(courseId, fileData) {
        if (!fileData || !fileData.text) return;
        const trimmed = (fileData.text || '').trim();
        if (trimmed.length < this.MIN_TEXT_LEN_TO_RECORD) return;

        this.coursesData[courseId].files.push({
            title: fileData.title || 'File',
            url: fileData.url,
            filename: fileData.filename || fileData.title || 'file',
            text: this.capText(trimmed, this.MAX_FILE_CHARS),
            metadata: fileData.metadata || {}
        });
    }

    async prefetchModuleFiles(courseId, baseUrl, courseState) {
        if (this.stopRequested) return;
        const moduleUrl = `${baseUrl}/modules`;
        console.log(`[SCRAPER-OLD] [Course ${courseId}] 🔍 Prefetching files from modules...`);

        try {
            const links = await this.executeScriptOnPage(moduleUrl, async (context) => {
                const allowedExtensions = context.allowedExtensions || [];

                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const expandModuleItems = async () => {
                    const expandButtons = document.querySelectorAll('button[aria-expanded="false"], .ig-header-collapse');
                    for (const btn of expandButtons) {
                        try {
                            btn.click();
                            await sleep(150);
                        } catch (e) {}
                    }
                    await sleep(500);
                };

                await new Promise(resolve => {
                    if (document.readyState === 'complete') {
                        resolve();
                    } else {
                        window.addEventListener('load', resolve);
                    }
                });
                await sleep(800);

                await expandModuleItems();

                const anchors = Array.from(document.querySelectorAll('a[href]'));
                const fileLinks = [];
                for (const anchor of anchors) {
                    const href = anchor.href || '';
                    if (href.includes('/files/') || allowedExtensions.some(ext => href.toLowerCase().includes(ext))) {
                        fileLinks.push(href);
                    }
                }
                return Array.from(new Set(fileLinks));
            }, 1, {
                courseId,
                allowedExtensions: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.rtf']
            });

            if (Array.isArray(links)) {
                for (const rawLink of links) {
                    if (this.stopRequested) break;
                    const normalized = this.normalizeCourseLink(rawLink, courseId);
                    if (!normalized || !this.isFileLink(normalized)) continue;

                    if (courseState.visitedFiles.has(normalized)) continue;
                    await this.scrapeFileLink(courseId, normalized, courseState);
                }
            }
        } catch (error) {
            console.warn(`[SCRAPER-OLD] [Course ${courseId}] Prefetch modules failed: ${error.message}`);
        }
    }

    async crawlCourse(courseId, baseUrl, courseState) {
        const seeds = this.buildCourseSeeds(courseId);
        seeds.forEach(seed => {
            const normalized = this.normalizeCourseLink(seed, courseId);
            if (!normalized) return;
            if (this.syllabusOnlyMode && !normalized.toLowerCase().includes('syllabus')) return;
            this.addSeedToQueue(courseState, normalized);
        });

        console.log(`[SCRAPER-OLD] [Course ${courseId}] 🔗 Starting BFS crawl with ${courseState.queue.length} seeds`);

        while (courseState.queue.length > 0 && !this.stopRequested) {
            if (courseState.visitedPages.size >= this.MAX_LINKS_PER_COURSE) {
                console.log(`[SCRAPER-OLD] [Course ${courseId}] ⚠️ Reached page limit (${this.MAX_LINKS_PER_COURSE})`);
                break;
            }

            if (this.restartInProgress && this.restartCourseId && this.restartCourseId !== courseId) {
                throw this.createRestartError();
            }

            const nextUrl = courseState.queue.shift();
            if (!nextUrl) continue;

            if (courseState.visitedPages.has(nextUrl)) {
                continue;
            }

            if (this.syllabusOnlyMode && !nextUrl.toLowerCase().includes('syllabus')) {
                continue;
            }

            courseState.visitedPages.add(nextUrl);
            console.log(`[SCRAPER-OLD] [Course ${courseId}] 🌐 Visiting ${nextUrl}`);

            try {
                const pageData = await this.scrapePageContent(courseId, nextUrl, courseState);
                if (pageData && pageData.text) {
                    this.storePageContent(courseId, pageData);
                }

                if (pageData && Array.isArray(pageData.links)) {
                    for (const link of pageData.links) {
                        if (!link || !link.url) continue;
                        const normalized = this.normalizeCourseLink(link.url, courseId);
                        if (!normalized) continue;

                        if (this.isFileLink(normalized)) {
                            if (!courseState.visitedFiles.has(normalized)) {
                                await this.scrapeFileLink(courseId, normalized, courseState);
                            }
                        } else if (!courseState.visitedPages.has(normalized) && !courseState.queue.includes(normalized)) {
                            this.addSeedToQueue(courseState, normalized);
                        }
                    }
                }
            } catch (error) {
                if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                    throw error;
                }
                console.warn(`[SCRAPER-OLD] [Course ${courseId}] Error crawling ${nextUrl}: ${error.message}`);
            }

            await this.sleep(300);
        }
    }

    async scrapePageContent(courseId, url, courseState) {
        try {
            const pageResult = await this.executeScriptOnPage(url, async (context) => {
                const courseId = context.courseId;
                const maxChars = context.maxChars || 50000;
                const allowedExtensions = context.allowedExtensions || [];

                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const tryExpandAll = async () => {
                    const selectors = [
                        'button[aria-label*="expand"]',
                        'button[class*="expand"]',
                        '.expand_collapse_all',
                        '#expand_collapse_all'
                    ];
                    for (const selector of selectors) {
                        const btns = document.querySelectorAll(selector);
                        for (const btn of btns) {
                            try {
                                btn.click();
                                await sleep(150);
                            } catch (e) {}
                        }
                    }

                    const details = document.querySelectorAll('details:not([open])');
                    for (const detail of details) {
                        try {
                            detail.open = true;
                        } catch (e) {}
                    }
                    await sleep(200);
                };

                const scrollPage = async () => {
                    let last = 0;
                    for (let i = 0; i < 20; i++) {
                        window.scrollTo(0, document.body.scrollHeight);
                        await sleep(300);
                        const current = document.body.scrollHeight;
                        if (current === last) break;
                        last = current;
                    }
                    window.scrollTo(0, 0);
                };

                const getVisibleText = () => {
                    try {
                        const body = document.body;
                        let text = '';
                        if (body && body.innerText) {
                            text = body.innerText;
                        } else if (body && body.textContent) {
                            text = body.textContent;
                        }
                        text = text || '';
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
                            if (!host.includes('canvas.cornell.edu') && !host.includes('instructure.com')) {
                                continue;
                            }
                            const text = (anchor.textContent || '').trim();
                            out.push({
                                url: href.toString(),
                                text,
                                isFile: href.pathname.includes('/files/') || allowedExtensions.some(ext => href.pathname.toLowerCase().endsWith(ext))
                            });
                        } catch (e) {}
                    }
                    return out;
                };

                    await new Promise(resolve => {
                        if (document.readyState === 'complete') {
                            resolve();
                        } else {
                            window.addEventListener('load', resolve);
                        }
                    });
                    await sleep(800);

                    await tryExpandAll();
                    await scrollPage();

                    const text = getVisibleText();
                    const links = collectLinks();

                    return {
                        text: text ? text.slice(0, maxChars) : '',
                        title: document.title || 'Untitled',
                        url: window.location.href,
                        links: links || [],
                        metadata: {
                            courseId,
                            scrapedAt: new Date().toISOString()
                        }
                    };
            }, 1, {
                courseId,
                maxChars: this.MAX_PAGE_CHARS,
                allowedExtensions: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.rtf']
            });

            return pageResult;
        } catch (error) {
            if (error.message && error.message.includes('Timeout waiting for page to load')) {
                await this.handleTimeoutRestart(courseId, url);
                throw this.createRestartError();
            }
            console.warn(`[SCRAPER-OLD] [Course ${courseId}] Page scrape failed for ${url}: ${error.message}`);
            return null;
        }
    }

    async scrapeFileLink(courseId, url, courseState) {
        if (courseState.visitedFiles.has(url)) return;
        console.log(`[SCRAPER-OLD] [Course ${courseId}] 📄 Scraping file ${url}`);

        try {
            const fileResult = await this.executeScriptOnPage(url, async (context) => {
                const courseId = context.courseId;
                const maxChars = context.maxChars || 200000;
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const ensureLoaded = async () => {
                    await new Promise(resolve => {
                        if (document.readyState === 'complete') {
                            resolve();
                        } else {
                            window.addEventListener('load', resolve);
                        }
                    });
                    await sleep(1000);
                };

                const scrollContainers = async () => {
                    const containers = document.querySelectorAll('.textLayer, .pdfViewer, .Pages, .ReactVirtualized__Grid, iframe');
                    for (const container of containers) {
                        try {
                            const target = container.contentDocument?.body || container;
                            let last = 0;
                            for (let i = 0; i < 12; i++) {
                                target.scrollTop = target.scrollHeight;
                                await sleep(200);
                                const current = target.scrollTop;
                                if (current === last) break;
                                last = current;
                            }
                        } catch (e) {}
                    }
                    window.scrollTo(0, document.body.scrollHeight);
                    await sleep(400);
                    window.scrollTo(0, 0);
                };

                const extractText = () => {
                    const clone = document.body.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript, nav, header, footer').forEach(el => el.remove());
                    const text = (clone.innerText || clone.textContent || '').replace(/\s+\n/g, '\n').trim();
                    return text.slice(0, maxChars);
                };

                await ensureLoaded();
                await scrollContainers();

                const text = extractText();
                let filename = '';
                const titleEl = document.querySelector('h1, h2');
                if (titleEl) {
                    filename = (titleEl.textContent || '').trim();
                }

                if (!filename) {
                    const path = new URL(window.location.href).pathname;
                    filename = path.split('/').pop() || 'file';
                }

                return {
                    text,
                    title: document.title || filename,
                    filename,
                    url: window.location.href,
                    metadata: {
                        courseId,
                        scrapedAt: new Date().toISOString()
                    }
                };
            }, 1, {
                courseId,
                maxChars: this.MAX_FILE_CHARS
            });

            if (fileResult && fileResult.text) {
                this.storeFileContent(courseId, fileResult);
                courseState.visitedFiles.add(url);
            }
        } catch (error) {
            if (error.message && error.message.includes('Timeout waiting for page to load')) {
                await this.handleTimeoutRestart(courseId, url);
                throw this.createRestartError();
            }
            console.warn(`[SCRAPER-OLD] [Course ${courseId}] File scrape failed for ${url}: ${error.message}`);
        }
    }

    // ===== MODIFIED executeScriptOnPage TO USE NEW LOGIC =====
    
    async executeScriptOnPage(url, scriptFunc, retries = 0, context = null) {
        const executeContext = context || {};
        let courseId = executeContext.courseId;
        
        if (!courseId) {
            const match = url.match(/\/courses\/(\d+)/);
            courseId = match ? match[1] : null;
        }
        
        if (this.restartInProgress && courseId && this.restartCourseId && this.restartCourseId !== courseId) {
            throw this.createRestartError();
        }
        
        const { workerId, tabId } = await this.acquireWorker(courseId);
        
        try {
            return await this._executeScriptOnWorkerTab(workerId, tabId, url, scriptFunc, executeContext);
        } catch (error) {
            throw error;
        } finally {
            this.releaseWorker(workerId);
        }
    }
    
    async _executeScriptOnWorkerTab(workerId, tabId, url, scriptFunc, context) {
        try {
            await this.navigateWorkerTab(workerId, url, context?.courseId || null);
        } catch (error) {
            console.log(`[SCRAPER-OLD] Failed to navigate worker tab, falling back to temporary tab: ${error.message}`);
            return await this._executeScriptOnTemporaryTab(url, scriptFunc, context);
        }
        
        return new Promise((resolve, reject) => {
            let resolved = false;
            let pageLoaded = false;
            
            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
                    pageLoaded = true;
                    chrome.tabs.onUpdated.removeListener(listener);
                    
                    setTimeout(async () => {
                        if (resolved) return;
                        
                        try {
                            const result = await chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                func: scriptFunc,
                                args: [context || {}]
                            });
                            
                            if (chrome.runtime.lastError) {
                                const errorMsg = chrome.runtime.lastError.message;
                                if (errorMsg.includes('Frame') || errorMsg.includes('removed')) {
                                    resolve(null);
                                } else {
                                    reject(new Error(errorMsg));
                                }
                                resolved = true;
                                return;
                            }
                            
                            if (result && result[0] && result[0].result !== undefined) {
                                resolve(result[0].result);
                            } else {
                                resolve(null);
                            }
                            resolved = true;
                        } catch (error) {
                            if (!resolved) {
                                reject(error);
                                resolved = true;
                            }
                        }
                    }, 2000);
                }
            };
            
            chrome.tabs.onUpdated.addListener(listener);
            
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    reject(new Error(`Failed to get tab: ${chrome.runtime.lastError.message}`));
                    resolved = true;
                    return;
                }
                
                if (tab.status === 'complete' && !resolved && !pageLoaded) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    pageLoaded = true;
                    
                    setTimeout(async () => {
                        if (resolved) return;
                        
                        try {
                            const result = await chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                func: scriptFunc,
                                args: [context || {}]
                            });
                            
                            if (chrome.runtime.lastError) {
                                const errorMsg = chrome.runtime.lastError.message;
                                if (errorMsg.includes('Frame') || errorMsg.includes('removed')) {
                                    resolve(null);
                                } else {
                                    reject(new Error(errorMsg));
                                }
                                resolved = true;
                                return;
                            }
                            
                            if (result && result[0] && result[0].result !== undefined) {
                                resolve(result[0].result);
                            } else {
                                resolve(null);
                            }
                            resolved = true;
                        } catch (error) {
                            if (!resolved) {
                                reject(error);
                                resolved = true;
                            }
                        }
                    }, 2000);
                }
            });
            
            setTimeout(() => {
                if (!resolved) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    const timeoutError = new Error(`Timeout waiting for page to load: ${url}`);
                    if (url.includes('/files/') || url.includes('/download')) {
                        timeoutError.isRestartRequired = true;
                    }
                    reject(timeoutError);
                    resolved = true;
                }
            }, 60000);
        });
    }
    
    async _executeScriptOnTemporaryTab(url, scriptFunc, context) {
        // Fallback to temporary tab (simplified version)
        return new Promise((resolve, reject) => {
            const createTabOptions = { url: url, active: false };
            if (this.targetWindowId) {
                createTabOptions.windowId = this.targetWindowId;
            }

            chrome.tabs.create(createTabOptions, async (tab) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to create tab: ${chrome.runtime.lastError.message}`));
                    return;
                }

                const tabId = tab.id;
                
                // Mark tab as non-discardable to prevent Chrome from unloading it
                chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {
                    // Ignore errors, continue anyway
                });
                
                // Ping the tab immediately to keep it alive
                this.pingTab(tabId);
                
                let resolved = false;

                const listener = (updatedTabId, changeInfo) => {
                    if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
                        chrome.tabs.onUpdated.removeListener(listener);
                        
                        setTimeout(async () => {
                            if (resolved) return;

                            try {
                                const result = await chrome.scripting.executeScript({
                                    target: { tabId: tabId },
                                    func: scriptFunc,
                                    args: [context || {}]
                                });
                                
                                chrome.tabs.remove(tabId).catch(() => {});

                                if (chrome.runtime.lastError) {
                                    const errorMsg = chrome.runtime.lastError.message;
                                    if (errorMsg.includes('Frame') || errorMsg.includes('removed')) {
                                        resolve(null);
                                    } else {
                                        reject(new Error(errorMsg));
                                    }
                                    resolved = true;
                                    return;
                                }

                                if (result && result[0] && result[0].result !== undefined) {
                                    resolve(result[0].result);
                                } else {
                                    resolve(null);
                                }
                                resolved = true;
                            } catch (error) {
                                chrome.tabs.remove(tabId).catch(() => {});
                                if (!resolved) {
                                    reject(error);
                                    resolved = true;
                                }
                            }
                        }, 2000);
                    }
                };

                chrome.tabs.onUpdated.addListener(listener);

                setTimeout(() => {
                    if (!resolved) {
                        chrome.tabs.onUpdated.removeListener(listener);
                        chrome.tabs.remove(tabId).catch(() => {});
                        reject(new Error(`Timeout waiting for page to load: ${url}`));
                        resolved = true;
                    }
                }, 60000);
            });
        });
    }

    // Worker pool tab management
    async initializeWorkerPool() {
        if (this.workerTabs.size >= this.workerPoolSize) {
            return;
        }
        
        const windowId = await this.ensureScrapingWindow();
        
        while (this.workerTabs.size < this.workerPoolSize && !this.stopRequested) {
            const workerId = `worker_${this.workerTabs.size + 1}`;
            const tabId = await this.createWorkerTab(windowId);
            this.workerTabs.set(workerId, {
                tabId,
                busy: false,
                courseId: null
            });
            this.availableWorkers.push(workerId);
            this.resolveNextWorkerWaiter();
        }
    }
    
    async createWorkerTab(windowId) {
        return await new Promise((resolve, reject) => {
            chrome.tabs.create({
                url: `${this.START_URL}/`,
                windowId,
                active: false
            }, (tab) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to create worker tab: ${chrome.runtime.lastError.message}`));
                    return;
                }
                
                const tabId = tab.id;
                chrome.tabs.update(tabId, { autoDiscardable: false }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[SCRAPER-OLD] Warning: Could not set autoDiscardable on worker tab ${tabId}: ${chrome.runtime.lastError.message}`);
                    }
                    this.pingTab(tabId);
                    resolve(tabId);
                });
            });
        });
    }
    
    async acquireWorker(courseId = null) {
        await this.initializeWorkerPool();
        
        while (!this.stopRequested) {
            if (this.availableWorkers.length > 0) {
                const workerId = this.availableWorkers.shift();
                const worker = this.workerTabs.get(workerId);
                if (worker) {
                    worker.busy = true;
                    worker.courseId = courseId;
                    return { workerId, tabId: worker.tabId };
                }
            }
            
            await new Promise(resolve => {
                this.workerWaiters.push(resolve);
            });
        }
        
        throw new Error('Scraping stopped');
    }
    
    releaseWorker(workerId) {
        const worker = this.workerTabs.get(workerId);
        if (!worker) return;
        
        worker.busy = false;
        worker.courseId = null;
        this.availableWorkers.push(workerId);
        this.resolveNextWorkerWaiter();
    }
    
    resolveNextWorkerWaiter() {
        const waiter = this.workerWaiters.shift();
        if (waiter) {
            waiter();
        }
    }
    
    async navigateWorkerTab(workerId, url, courseId = null) {
        const worker = this.workerTabs.get(workerId);
        if (!worker) throw new Error(`No worker found with id ${workerId}`);
        
        return await new Promise((resolve, reject) => {
            chrome.tabs.update(worker.tabId, { url, autoDiscardable: false }, (tab) => {
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message;
                    reject(new Error(`Failed to navigate worker tab: ${errorMsg}`));
                    return;
                }
                
                this.pingTab(worker.tabId, courseId);
                resolve(worker.tabId);
            });
        });
    }
    
    async cleanupWorkerTabs() {
        for (const [, worker] of this.workerTabs.entries()) {
            if (worker?.tabId) {
                try {
                    await chrome.tabs.remove(worker.tabId);
                } catch (e) {}
            }
        }
        this.workerTabs.clear();
        this.availableWorkers = [];
        const waiters = this.workerWaiters.splice(0);
        waiters.forEach(waiter => {
            try {
                waiter();
            } catch (e) {}
        });
    }
    
    async closeAllScrapingTabs() {
        await this.cleanupWorkerTabs();
        
        if (this.targetWindowId) {
            try {
                const tabs = await new Promise((resolve) => {
                    chrome.tabs.query({ windowId: this.targetWindowId }, resolve);
                });
                for (const tab of tabs) {
                    try {
                        await chrome.tabs.remove(tab.id);
                    } catch (e) {}
                }
            } catch (e) {}
        }
    }
    
    async ensureScrapingWindow() {
        if (this.targetWindowId) {
            try {
                const window = await new Promise((resolve) => {
                    chrome.windows.get(this.targetWindowId, resolve);
                });
                if (window && !chrome.runtime.lastError) {
                    // Mark all tabs in the window as non-discardable and ping them
                    chrome.tabs.query({ windowId: this.targetWindowId }, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
                            // Ping each tab immediately to keep it alive
                            this.pingTab(tab.id);
                        });
                    });
                    return this.targetWindowId;
                }
            } catch (error) {}
        }
        
        return new Promise((resolve) => {
            chrome.windows.create({
                url: 'https://canvas.cornell.edu/',
                type: 'normal',
                focused: false,
                width: 800,
                height: 600
            }, (newWindow) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                } else {
                    // Mark the initial tab as non-discardable and ping it
                    chrome.tabs.query({ windowId: newWindow.id }, (tabs) => {
                        if (tabs.length > 0) {
                            const tabId = tabs[0].id;
                            chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
                            // Ping the tab immediately to keep it alive
                            this.pingTab(tabId);
                        }
                    });
                    
                    chrome.storage.local.set({
                        [`scrapingWindow_${newWindow.id}`]: true
                    });
                    resolve(newWindow.id);
                }
            });
        });
    }

    // ===== POST-PROCESSING METHODS (KEPT FROM ORIGINAL) =====
    
    async removeHtmlFromCorpus() {
        const processContent = (content) => {
            if (!content || typeof content !== 'string') return content;
            content = content.replace(/<[^>]*>/g, '');
            content = content.replace(/&[#\w]+;/g, ' ');
            content = content.replace(/\n/g, ' ');
            content = content.replace(/\s+/g, ' ').trim();
            return content;
        };

        for (const courseId in this.coursesData) {
            const course = this.coursesData[courseId];
            if (Array.isArray(course.pages)) {
                course.pages = course.pages.map(page => {
                    if (!page) return page;
                    if (page.text) {
                        page.text = processContent(page.text);
                    }
                    return page;
                });
            }
            if (Array.isArray(course.files)) {
                course.files = course.files.map(file => {
                    if (!file) return file;
                    if (file.text) {
                        file.text = processContent(file.text);
                    }
                    return file;
                });
            }
        }
    }

    formatCorpusForGPT() {
        let corpus = '';
        for (const courseId in this.coursesData) {
            const course = this.coursesData[courseId];
            corpus += `\n\n=== COURSE: ${course.name || courseId} ===\n\n`;

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

            if (course.summary && Array.isArray(course.summary)) {
                for (const note of course.summary) {
                    corpus += `--- NOTE ---\n${note}\n\n`;
                }
            }
        }
        return corpus;
    }

    async processGPTSingleBatch(batchText, batchNumber, totalBatches) {
        const openaiApiKey = await new Promise((resolve) => {
            chrome.storage.sync.get(['openaiApiKey'], (result) => {
                resolve(result.openaiApiKey || '');
            });
        });

        if (!openaiApiKey) {
            throw new Error('OpenAI API key not configured');
        }

        const prompt = `You are an educational content cleaning and organization assistant. Your job is to take messy, HTML-scraped, unstructured educational content from Canvas LMS and clean it up, removing all HTML artifacts and organizing it by course.

PRIMARY GOAL: Clean HTML scraping artifacts (remnants of tags, attributes, broken formatting) and organize ALL information by course.

CRITICAL CONTENT REQUIREMENTS - You MUST preserve and include ALL of the following for EACH course:
1. COMPLETE syllabus information
2. ALL assignments and problem sets (PSETS) with dates
3. ALL exam information with dates
4. ALL readings with detailed summaries
5. ALL lecture information
6. ALL notes and supplementary materials
7. ALL dates for everything
8. Grade information
9. Course policies

OUTPUT FORMAT: Output clean, readable text organized by course.

OUTPUT LENGTH: Target decreasing the length of the content by 50%.

--- CONTENT START ---
${batchText}
--- CONTENT END ---

Now clean and organize the content above. Remove all HTML artifacts and organize by course, preserving ALL dates, assignments, PSETS, readings, lectures, notes, grades, and syllabus information.`;

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

        this.sendProgress(`GPT batch ${batchNumber}/${totalBatches} complete (${restructured.length} chars)`);
        return restructured;
    }

    async restructureCorpusWithGPT() {
        const corpus = this.formatCorpusForGPT();
        
        if (!corpus || corpus.trim().length === 0) {
            console.log('[SCRAPER-OLD] No corpus to restructure');
            return;
        }

        const charCount = corpus.length;
        const charsPerBatch = 400000 * 4;
        const numBatches = Math.ceil(charCount / charsPerBatch) || 1;

        console.log(`[SCRAPER-OLD] Corpus size: ${charCount} chars, splitting into ${numBatches} batch(es)`);
        this.sendProgress(`Restructuring corpus (${numBatches} batch${numBatches > 1 ? 'es' : ''})...`);

        const batches = [];
        for (let i = 0; i < numBatches; i++) {
            const start = i * charsPerBatch;
            const end = Math.min(start + charsPerBatch, charCount);
            batches.push(corpus.substring(start, end));
        }

        const restructuredBatches = [];
        for (let i = 0; i < batches.length; i++) {
            if (this.stopRequested) break;
            
            try {
                const restructured = await this.processGPTSingleBatch(batches[i], i + 1, batches.length);
                restructuredBatches.push(restructured);
                
                if (i < batches.length - 1) {
                    await this.sleep(1000);
                }
            } catch (error) {
                console.error(`[SCRAPER-OLD] Error processing GPT batch ${i + 1}:`, error);
                restructuredBatches.push(batches[i]);
            }
        }

        const compressedContext = restructuredBatches.join('\n\n');
        
        for (const courseId in this.coursesData) {
            this.coursesData[courseId].compressedContext = compressedContext;
        }

        this.coursesData._compressedContext = compressedContext;

        console.log(`[SCRAPER-OLD] Compressed context created (${compressedContext.length} chars)`);
    }

    async saveScrapedData() {
        const dataToSave = {
            courses: this.coursesData,
            lastScraped: Date.now(),
            version: '1.0'
        };

        try {
            await chrome.storage.local.set({ scrapedCanvasData: dataToSave });
            console.log('[SCRAPER-OLD] Saved scraped data to storage');
        } catch (error) {
            console.error('[SCRAPER-OLD] Error saving scraped data:', error);
        }
    }

    async getScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['scrapedCanvasData'], (result) => {
                resolve(result.scrapedCanvasData || null);
            });
        });
    }

    async clearScrapedData() {
        this.coursesData = {};
        this.scrapedUrls = new Set();
        this.courseScrapingState.clear();
        this.workerTabs.clear();
        try {
            await chrome.storage.local.remove(['scrapedCanvasData']);
            console.log('[SCRAPER-OLD] Cleared scraped data');
        } catch (error) {
            console.error('[SCRAPER-OLD] Error clearing scraped data:', error);
        }
    }

    sendProgress(message) {
        if (this.progressCallback) {
            this.progressCallback(message);
        }
        console.log(`[SCRAPER-OLD] ${message}`);
    }

    startKeepAwake() {
        this.keepAwakeInterval = setInterval(() => {
            // No-op
        }, 25000);
    }

    stopKeepAwake() {
        if (this.keepAwakeInterval) {
            clearInterval(this.keepAwakeInterval);
            this.keepAwakeInterval = null;
        }
    }
    
    // Keep-alive mechanism: ping tabs immediately when they're created
    startKeepAlive() {
        // No longer using alarms - we ping tabs immediately when created
        console.log('[SCRAPER-OLD] Started keep-alive mechanism (pinging tabs on creation)');
    }
    
    stopKeepAlive() {
        // No cleanup needed since we're not using alarms
        console.log('[SCRAPER-OLD] Stopped keep-alive mechanism');
    }
    
    // Ping a single tab to keep it alive (called immediately after tab creation)
    async pingTab(tabId, courseId = null) {
        if (!this.scrapingInProgress) return;
        
        try {
            // Wait a moment for the tab to be ready
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check if tab still exists
            const tab = await new Promise((resolve) => {
                chrome.tabs.get(tabId, resolve);
            });
            
            if (tab && !chrome.runtime.lastError) {
                // Try to send a ping message (this keeps the tab "active")
                chrome.tabs.sendMessage(tabId, { type: 'PING', courseId: courseId }, (response) => {
                    if (chrome.runtime.lastError) {
                        // Tab might not be ready yet, that's okay
                        console.log(`[SCRAPER-OLD] ${courseId ? `[Course ${courseId}]` : ''} Tab ${tabId} not ready for ping yet`);
                    } else {
                        console.log(`[SCRAPER-OLD] ${courseId ? `[Course ${courseId}]` : ''} Tab keep-alive ping successful`);
                    }
                });
                
                // Also ensure autoDiscardable is false
                chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
            }
        } catch (e) {
            // Tab doesn't exist or error occurred, that's okay
            console.log(`[SCRAPER-OLD] ${courseId ? `[Course ${courseId}]` : ''} Could not ping tab ${tabId}`);
        }
    }

    resetRestartState() {
        this.needsRestart = false;
        this.restartReason = null;
        this.restartCourseId = null;
        this.restartFileUrl = null;
        this.restartInProgress = false;
    }

    createRestartError() {
        const error = new Error('RESTART_REQUIRED');
        error.isRestartRequired = true;
        error.restartReason = this.restartReason;
        error.restartCourseId = this.restartCourseId;
        error.restartUrl = this.restartFileUrl;
        return error;
    }

    async closeScrapingWindow() {
        await this.cleanupWorkerTabs();
        
        if (this.targetWindowId) {
            const windowId = this.targetWindowId;
            await new Promise((resolve) => {
                chrome.windows.remove(windowId, () => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[SCRAPER-OLD] Warning closing window ${windowId}: ${chrome.runtime.lastError.message}`);
                    }
                    resolve();
                });
            });
            this.targetWindowId = null;
            // Clean up storage marker if it exists
            chrome.storage.local.remove(`scrapingWindow_${windowId}`);
        }
    }

    async handleTimeoutRestart(courseId, url) {
        if (this.restartInProgress) {
            return;
        }

        this.restartInProgress = true;
        this.restartReason = 'PAGE_TIMEOUT';
        this.restartCourseId = courseId;
        this.restartFileUrl = url;
        this.stopRequested = false;

        const normalizedUrl = this.normalizeCourseLink(url, courseId) || url;
        const courseState = this.courseScrapingState.get(courseId);
        if (courseState) {
            if (courseState.visitedPages) {
                courseState.visitedPages.delete(normalizedUrl);
            }
            if (courseState.queue && !courseState.queue.includes(normalizedUrl)) {
                courseState.queue.unshift(normalizedUrl);
            }
            if (courseState.visitedFiles) {
                courseState.visitedFiles.delete(normalizedUrl);
            }
        }

        if (this.coursesData[courseId]) {
            this.coursesData[courseId].fullyCompleted = false;
        }

        this.sendProgress(`[Course ${courseId}] Timeout detected. Restarting scraping window...`);

        await this.closeScrapingWindow();

        await this.sleep(1500);

        const newWindowId = await this.ensureScrapingWindow();
        if (newWindowId) {
            this.targetWindowId = newWindowId;
        }

        this.sendProgress('Scraping window restarted. Resuming scraping...');
    }

    logDetailedError(errorContext) {
        const errorLogEntry = {
            timestamp: new Date().toISOString(),
            elapsedTime: this.scrapingStartTime ? Date.now() - this.scrapingStartTime : null,
            errorType: errorContext.errorType || 'UNKNOWN',
            errorMessage: errorContext.errorMessage || 'Unknown error',
            errorStack: errorContext.errorStack || null,
            courseId: errorContext.courseId || null,
            courseName: errorContext.courseName || null,
            scrapingSection: errorContext.scrapingSection || null,
            url: errorContext.url || null,
            operation: errorContext.operation || null
        };
        
        this.errorLog.push(errorLogEntry);
        console.error(`[SCRAPER-OLD] Error: ${errorLogEntry.errorType} - ${errorLogEntry.errorMessage}`);
    }
}

