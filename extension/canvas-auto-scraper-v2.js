// Canvas Auto-Scraper v2 - Based on canvas_scraper.py logic
// Matches the flow of run_canvas_scrape_job and get_fall_2025_course_ids

class CanvasAutoScraper {
    constructor() {
        this.scrapingInProgress = false;
        this.coursesData = {};
        this.targetWindowId = null; // Window to create tabs in
        this.keepAwakeInterval = null;
        this.stopRequested = false; // Flag for stop button
        this.activeScrapingPromises = []; // Track parallel scraping operations
        
        // Courses to skip (login pages, help pages, or invalid courses)
        this.excludedCourseIds = [
            '14918', // Career Development Toolkit - join course page
            '14901', // Login/help page
            '45845', // Login/help page
            '40187', // Login/help page
            '46043'  // Login/help page
        ];
        
        this.syllabusOnlyMode = false; // Flag for syllabus-only scraping mode
        this.errorPageErrorCount = 0; // Track consecutive error page errors
        this.lastErrorPageError = null; // Track when last error occurred
        this.retryAttempts = 0; // Track retry attempts to prevent infinite loops
    }
    
    // Stop scraping gracefully
    async stopScraping() {
        console.log('[SCRAPER] Stop requested by user');
        this.stopRequested = true;
        
        // Close all scraping tabs
        if (this.targetWindowId) {
            try {
                const tabs = await new Promise((resolve) => {
                    chrome.tabs.query({windowId: this.targetWindowId}, resolve);
                });
                for (const tab of tabs) {
                    try {
                        await chrome.tabs.remove(tab.id);
                    } catch (e) {
                        // Ignore errors
                    }
                }
            } catch (e) {
                // Ignore errors
            }
        }
        
        // Wait for all active scraping operations to complete or cancel
        if (this.activeScrapingPromises.length > 0) {
            console.log(`[SCRAPER] Waiting for ${this.activeScrapingPromises.length} active scraping operations to finish...`);
            await Promise.allSettled(this.activeScrapingPromises);
        }
        
        this.sendProgress('⚠ Scraping stopped by user. Processing collected data...');
    }

    // Extract all scraped URLs from existing corpus
    extractScrapedUrls(existingData) {
        const scrapedUrls = new Set();
        if (existingData && existingData.courses) {
            for (const courseId in existingData.courses) {
                const course = existingData.courses[courseId];
                if (course.pages) {
                    for (const pageName in course.pages) {
                        const page = course.pages[pageName];
                        if (page.url) {
                            scrapedUrls.add(page.url);
                        }
                    }
                }
            }
        }
        return scrapedUrls;
    }

    // Merge new data with existing corpus
    mergeWithExistingCorpus(newData, existingData) {
        if (!existingData || !existingData.courses) {
            return newData;
        }

        const merged = JSON.parse(JSON.stringify(existingData)); // Deep copy
        
        // Merge courses
        for (const courseId in newData.courses) {
            if (!merged.courses[courseId]) {
                // New course - add entirely
                merged.courses[courseId] = newData.courses[courseId];
            } else {
                // Existing course - merge pages
                const existingCourse = merged.courses[courseId];
                const newCourse = newData.courses[courseId];
                
                // Merge pages
                if (!existingCourse.pages) {
                    existingCourse.pages = {};
                }
                
                for (const pageName in newCourse.pages) {
                    // Only add if page doesn't exist or URL is different
                    const newPage = newCourse.pages[pageName];
                    let shouldAdd = true;
                    
                    // Check if a page with this URL already exists
                    for (const existingPageName in existingCourse.pages) {
                        const existingPage = existingCourse.pages[existingPageName];
                        if (existingPage.url === newPage.url && existingPage.url) {
                            shouldAdd = false;
                            break;
                        }
                    }
                    
                    if (shouldAdd) {
                        existingCourse.pages[pageName] = newPage;
                    }
                }
            }
        }
        
        merged.lastScraped = Date.now();
        return merged;
    }

    // Main entry point - matches run_canvas_scrape_job
    async startAutoScrape(progressCallback, windowId = null, syllabusOnlyMode = false) {
        if (this.scrapingInProgress) {
            console.log('Scraping already in progress');
            return;
        }

        console.log('[SCRAPER] Starting automated Canvas scrape...');
        this.scrapingInProgress = true;
        this.stopRequested = false; // Reset stop flag for new scrape
        this.syllabusOnlyMode = syllabusOnlyMode; // Set syllabus-only mode from parameter
        this.progressCallback = progressCallback;
        this.targetWindowId = windowId; // Store the window ID to use for tabs

        // START keep-awake mechanism
        this.startKeepAwake();

        try {
            // Step 0: Load existing corpus and extract scraped URLs
            this.sendProgress('Loading existing corpus...');
            const existingData = await this.getScrapedData();
            this.scrapedUrls = this.extractScrapedUrls(existingData);
            
            if (existingData && Object.keys(existingData.courses || {}).length > 0) {
                console.log(`[SCRAPER] Found existing corpus with ${this.scrapedUrls.size} already-scraped URLs`);
                this.sendProgress(`Found existing corpus with ${this.scrapedUrls.size} scraped pages. Only new pages will be scraped.`);
                
                // Initialize with existing data (will be merged later)
                this.coursesData = JSON.parse(JSON.stringify(existingData.courses || {}));
            } else {
                console.log('[SCRAPER] No existing corpus found. Starting fresh scrape.');
                this.coursesData = {};
            }

            // Step 1: Get course IDs from dashboard (like get_fall_2025_course_ids)
            this.sendProgress('Discovering courses on dashboard...');
            const courseIds = await this.getDashboardCourseIds();
            console.log(`[SCRAPER] Found ${courseIds.length} courses: ${courseIds}`);

            if (courseIds.length === 0) {
                console.log('[SCRAPER] No courses found on dashboard');
                this.sendProgress('No courses found');
                await this.saveScrapedData();
                return;
            }

            this.sendProgress(`Found ${courseIds.length} courses. Starting parallel scrape...`);

            // Step 2: Scrape all courses in parallel (one tab per course)
            this.stopRequested = false;
            this.activeScrapingPromises = [];
            
            // Track course progress
            let completedCourses = 0;
            const totalCourses = courseIds.length;
            this.sendProgress(`progress:${completedCourses}/${totalCourses}`);
            
            const courseScrapingPromises = courseIds.map((courseId, index) => {
                const promise = this.scrapeCourse(courseId).catch((error) => {
                    console.error(`[SCRAPER] Error scraping course ${courseId}:`, error);
                    return null; // Continue with other courses even if one fails
                }).finally(() => {
                    // Update progress when each course completes
                    completedCourses++;
                    this.sendProgress(`progress:${completedCourses}/${totalCourses}`);
                });
                this.activeScrapingPromises.push(promise);
                return promise;
            });
            
            // Wait for all courses to complete or stop
            const results = await Promise.allSettled(courseScrapingPromises);
            
            // Clear active promises
            this.activeScrapingPromises = [];
            
            // Check immediately if we need to restart due to errors
            if (this.errorPageErrorCount >= 2 && this.retryAttempts < 2) {
                console.log(`[SCRAPER] Got ${this.errorPageErrorCount} consecutive errors, closing window and retrying...`);
                this.sendProgress(`⚠ Got ${this.errorPageErrorCount} consecutive errors. Restarting scrape...`);
                
                // Close ALL tabs in the current scraping window
                if (this.targetWindowId) {
                    try {
                        const tabs = await new Promise((resolve) => {
                            chrome.tabs.query({windowId: this.targetWindowId}, resolve);
                        });
                        console.log(`[SCRAPER] Closing ${tabs.length} tabs in scraping window...`);
                        for (const tab of tabs) {
                            try {
                                await chrome.tabs.remove(tab.id);
                            } catch (e) {
                                // Ignore tab removal errors
                            }
                        }
                        // Wait a moment for tabs to close
                        await this.sleep(1000);
                        // Remove the window itself
                        try {
                            await chrome.windows.remove(this.targetWindowId);
                        } catch (e) {
                            console.log('[SCRAPER] Could not remove window (may already be closed):', e);
                        }
                    } catch (e) {
                        console.log('[SCRAPER] Error closing window:', e);
                    }
                }
                
                // Reset error tracking
                this.errorPageErrorCount = 0;
                this.lastErrorPageError = null;
                this.retryAttempts++;
                
                // Wait a bit before retrying to let everything settle
                await this.sleep(3000);
                
                // Restart scraping (will create new window)
                console.log('[SCRAPER] Restarting scrape with new window...');
                this.sendProgress('Restarting scrape with fresh window...');
                await this.startAutoScrape(this.progressCallback, null, this.syllabusOnlyMode);
                return;
            }
            
            if (this.stopRequested) {
                this.sendProgress('⚠ Scraping stopped. Processing collected data...');
            } else {
                this.sendProgress('✓ All courses scraped');
            }
            
            // Reset error tracking for next run
            this.errorPageErrorCount = 0;
            this.lastErrorPageError = null;
            this.retryAttempts = 0;

            // Step 3: Merge with existing corpus and save
            this.sendProgress('Merging with existing corpus...');
            const existingDataForMerge = await this.getScrapedData();
            const mergedData = this.mergeWithExistingCorpus(
                { courses: this.coursesData },
                existingDataForMerge
            );
            
            // Update coursesData with merged data
            this.coursesData = mergedData.courses;
            
            this.sendProgress('Saving merged data...');
            await this.saveScrapedData();

            // Step 3.5: Remove HTML elements from corpus before indexing (ALWAYS runs, even if stopped)
            this.sendProgress('Cleaning HTML from scraped data...');
            this.removeHtmlFromCorpus(this.coursesData);

            // Step 3.6: Restructure corpus with GPT-5-nano (ALWAYS runs, even if stopped early)
            this.sendProgress('Restructuring corpus with GPT API...');
            try {
                await this.restructureCorpusWithGPT(this.coursesData);
                this.sendProgress('✓ Corpus restructured');
            } catch (error) {
                console.error('[SCRAPER] Failed to restructure corpus:', error);
                this.sendProgress('⚠ Corpus restructuring failed, using original data');
            }

            // Step 4: Index data for RAG (ALWAYS runs, even if stopped early)
            this.sendProgress('Indexing data for semantic search...');
            try {
                const rag = new ExtensionRAG();
                await rag.indexScrapedData(this.coursesData);
                this.sendProgress('✓ Data indexed for RAG');
            } catch (error) {
                console.error('[SCRAPER] Failed to index data:', error);
                this.sendProgress('⚠ Indexing failed, but data saved locally');
            }

            if (this.stopRequested) {
                console.log('[SCRAPER] Scraping stopped early, but post-processing completed');
                this.sendProgress('✓ Processing complete (scraping was stopped)');
            } else {
            console.log('[SCRAPER] Automated scraping complete!');
            this.sendProgress('✓ Scraping complete!');
            }
            this.scrapingInProgress = false;

        } catch (error) {
            console.error('[SCRAPER] Error during auto-scrape:', error);
            this.scrapingInProgress = false;
            throw error;
        } finally {
            // STOP keep-awake mechanism
            this.stopKeepAwake();
        }
    }

    // Get course IDs from dashboard - matches get_fall_2025_course_ids fallback logic
    async getDashboardCourseIds() {
        console.log('[SCRAPER] Getting course IDs from dashboard...');

        // Execute script on dashboard to find course links
        const allCourseIds = await this.executeScriptOnPage('https://canvas.cornell.edu/', () => {
            // Wait for dashboard to fully render by checking for course cards
            const waitForCourses = () => {
                return new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                        const cards = document.querySelectorAll('[class*="ic-DashboardCard"]');
                        if (cards.length > 0) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);

                    // Timeout after 5 seconds
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        resolve();
                    }, 5000);
                });
            };

            return waitForCourses().then(() => {
                // Extract from full HTML to catch all course IDs
                const html = document.documentElement.innerHTML;
                const matches = html.matchAll(/\/courses\/(\d+)/g);
                const courseIds = [];

                for (const match of matches) {
                    const courseId = match[1];
                    // Filter out user profile IDs and duplicates
                    if (!courseIds.includes(courseId) && !html.includes(`/users/${courseId}`)) {
                        courseIds.push(courseId);
                    }
                }

                console.log(`[SCRAPER] Found ${courseIds.length} unique course IDs before filtering:`, courseIds);
                
                // Filter out excluded courses (must be done after extraction since excludedCourseIds is instance property)
                // This will be done in the calling function
                
                return courseIds;
            });
        });

        if (!allCourseIds || allCourseIds.length === 0) {
            return [];
        }

        // Filter out excluded course IDs
        const filteredCourseIds = allCourseIds.filter(courseId => 
            !this.excludedCourseIds.includes(courseId)
        );

        const excludedCount = allCourseIds.length - filteredCourseIds.length;
        if (excludedCount > 0) {
            console.log(`[SCRAPER] Excluded ${excludedCount} course(s): ${this.excludedCourseIds.filter(id => allCourseIds.includes(id)).join(', ')}`);
        }

        console.log(`[SCRAPER] Proceeding with ${filteredCourseIds.length} course(s) after filtering`);
        return filteredCourseIds;
    }

    // Scrape a single course - matches run_course_crawl + crawl_course logic
    // Constants matching Python (exact values from canvas_scraper.py)
    get MAX_LINKS_PER_COURSE() { return 250; }
    get MIN_TEXT_LEN_TO_RECORD() { return 80; }
    get MAX_PAGE_CHARS() { return 50000; }
    get MAX_FILE_CHARS() { return 200000; }
    get ALLOWED_EXT_FOR_EXTRACTION() { 
        return ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.rtf'];
    }

    // normalize_link - EXACT Python logic (lines 205-240)
    normalizeLink(href, courseId) {
        if (!href || typeof href !== 'string') return '';
        href = href.trim();
        if (!href) return '';

        try {
            const base = 'https://canvas.cornell.edu';
            const fullUrl = href.startsWith('http') ? href : new URL(href, base + '/').href;
            const url = new URL(fullUrl);

            if (!url.hostname.includes('canvas.cornell.edu')) {
                return '';
            }

            url.hash = ''; // Remove fragment (matches Python p._replace(fragment=""))
            const cleanUrl = url.href;
            const path = url.pathname;

            const inCourse = path.startsWith(`/courses/${courseId}`) || path.includes(`/courses/${courseId}/`);
            const isFile = path.includes('/files/');
            if (!inCourse && !isFile) {
                return '';
            }

            const badPaths = ['/login', '/conversations', '/calendar', '/profile', '/settings/profile', '/settings/notifications'];
            if (badPaths.some(bad => path.includes(bad))) {
                return '';
            }

            return cleanUrl;
        } catch (e) {
            return '';
        }
    }

    // get_course_title - EXACT Python logic (lines 194-202)
    async getCourseTitle(courseId, baseUrl) {
        try {
            const titleData = await this.executeScriptOnPage(baseUrl, () => {
                try {
                    const h1 = document.querySelector('h1[class*="course-title"], h1[class*="page-title"]');
                    if (h1 && h1.textContent) {
                        return h1.textContent.trim();
                    }
                } catch (e) {}
                
                try {
                    return document.title.trim();
                } catch (e) {
                    return '';
                }
            });
            
            // Sanitize (matches Python sanitize function line 59-60)
            if (titleData) {
                const sanitized = titleData.replace(/[^a-zA-Z0-9 _-]/g, '_').trim();
                return sanitized || 'Course';
            }
            return `Course ${courseId}`;
        } catch (e) {
            return `Course ${courseId}`;
        }
    }

    // run_course_crawl - EXACT Python workflow (lines 849-891)
    async runCourseCrawl(courseId) {
        const baseUrl = `https://canvas.cornell.edu/courses/${courseId}`;

        // Navigate to base (matches driver.get line 851)
        await this.executeScriptOnPage(baseUrl, () => {
            // Navigation happens via tab creation
        });

        // try_expand_all with timeout=5 (matches Python line 852)
        await this.tryExpandAll(baseUrl, 5);
        await this.sleep(1000); // time.sleep(1.0) line 853

        // get_course_title (matches Python line 855)
        const courseName = await this.getCourseTitle(courseId, baseUrl);
        console.log(`[SCRAPER]   Course name: ${courseName}`);

        // Initialize course data structure
        this.coursesData[courseId] = {
            id: courseId,
            name: courseName,
            pages: {},
            scrapedAt: Date.now()
        };

        // BFS crawl (matches Python crawl_course)
        await this.crawlCourse(courseId, baseUrl, courseName);
    }

    // try_expand_all - EXACT Python logic (lines 144-165)
    async tryExpandAll(url, timeout = 5) {
        try {
            const result = await this.executeScriptOnPage(url, () => {
                const btn = document.getElementById('expand_collapse_all');
                if (!btn) return { success: false };

                const aria = (btn.getAttribute('aria-expanded') || '').trim().toLowerCase();
                const de = (btn.getAttribute('data-expand') || '').trim().toLowerCase();
                const shouldClick = (aria === 'false') || (de === 'false') || (!aria && !de);

                if (shouldClick) {
                    btn.click();
                    // Wait for expansion (matches Python WebDriverWait)
                    const startTime = Date.now();
                    while (Date.now() - startTime < timeout * 1000) {
                        const currentAria = (btn.getAttribute('aria-expanded') || '').trim().toLowerCase();
                        const currentDe = (btn.getAttribute('data-expand') || '').trim().toLowerCase();
                        if (currentAria === 'true' || currentDe === 'true') {
                            return { success: true };
                        }
                    }
                    return { success: true }; // Assume expanded after timeout
                }
                return { success: true };
            }, 1);

            return result && result.success;
        } catch (e) {
            return false;
        }
    }

    // Extract file text from Canvas (matches download + extract workflow but read-only)
    async extractFileFromCanvas(fileUrl) {
        try {
            const fileData = await this.executeScriptOnPage(fileUrl, () => {
                // try_expand_all with timeout 3 (matches Python)
                try {
                    const btn = document.getElementById('expand_collapse_all');
                    if (btn) {
                        const aria = (btn.getAttribute('aria-expanded') || '').trim().toLowerCase();
                        const de = (btn.getAttribute('data-expand') || '').trim().toLowerCase();
                        if (aria === 'false' || de === 'false' || (!aria && !de)) {
                            btn.click();
                            const startTime = Date.now();
                            while (Date.now() - startTime < 3000) {
                                const currentAria = (btn.getAttribute('aria-expanded') || '').trim().toLowerCase();
                                const currentDe = (btn.getAttribute('data-expand') || '').trim().toLowerCase();
                                if (currentAria === 'true' || currentDe === 'true') break;
                            }
                        }
                    }
                } catch (e) {}

                // Wait for PDF to render - increase wait time for Canvas PDFs (need more than 1.2s)
                const waitStart = Date.now();
                while (Date.now() - waitStart < 3000) {}
                
                // Wait for TextLayer to appear (important for Canvas PDFs)
                let textLayerAppeared = false;
                const checkInterval = 100;
                const maxWaitForTextLayer = 5000;
                let waitedForTextLayer = 0;
                while (waitedForTextLayer < maxWaitForTextLayer) {
                    const textLayers = document.querySelectorAll('.TextLayer-container .textLayer, .textLayer, .TextLayer-container, [class*="TextLayer"]');
                    if (textLayers.length > 0) {
                        textLayerAppeared = true;
                        break;
                    }
                    const wait = Date.now();
                    while (Date.now() - wait < checkInterval) {}
                    waitedForTextLayer += checkInterval;
                }

                // Extract text from file viewer - scroll through ENTIRE document
                let allText = '';
                
                // Try Canvas TextLayer-container extraction first (most reliable for Canvas PDFs)
                // IMPORTANT: Need to scroll first to trigger text rendering in some viewers
                // First scroll internal containers like .Pages for Canvas PDF viewers
                const internalContainers = document.querySelectorAll('.Pages, [class*="Pages"], .content, [class*="content"]');
                for (const container of internalContainers) {
                    let lastScroll = 0;
                    for (let j = 0; j < 12; j++) {
                        container.scrollTop = container.scrollHeight;
                        const scrollStart = Date.now();
                        while (Date.now() - scrollStart < 200) {}
                        
                        if (container.scrollTop === lastScroll) break;
                        lastScroll = container.scrollTop;
                    }
                    // Reset to top after scrolling
                    container.scrollTop = 0;
                }
                
                // Then scroll window
                const scrollStart = Date.now();
                while (Date.now() - scrollStart < 500) {
                    window.scrollTo(0, document.body.scrollHeight);
                }
                window.scrollTo(0, 0); // Reset to top
                
                // Try Canvas TextLayer extraction - look for all variations
                // Prioritize .textLayer elements inside .TextLayer-container, then fall back to container itself
                const textLayerElements = document.querySelectorAll('.TextLayer-container .textLayer, .textLayer');
                if (textLayerElements.length > 0) {
                    // Get text from .textLayer elements (these contain the actual text)
                    for (const layer of textLayerElements) {
                        const layerText = layer.innerText || layer.textContent || '';
                        if (layerText.trim()) {
                            allText += (allText ? '\n\n' : '') + layerText;
                        } else {
                            // Also try getting text from child elements (spans in TextLayer)
                            const childText = Array.from(layer.querySelectorAll('span, div'))
                                .map(el => el.innerText || el.textContent || '')
                                .filter(t => t.trim())
                                .join(' ');
                            if (childText.trim()) {
                                allText += (allText ? '\n\n' : '') + childText;
                            }
                        }
                    }
                    if (allText.trim()) {
                        return allText.trim();
                    }
                }
                
                // Fallback: try TextLayer-container directly
                const textLayerContainers = document.querySelectorAll('.TextLayer-container, [class*="TextLayer-container"]');
                if (textLayerContainers.length > 0) {
                    for (const container of textLayerContainers) {
                        // Try to get text from the container itself
                        const containerText = container.innerText || container.textContent || '';
                        if (containerText.trim()) {
                            allText += (allText ? '\n\n' : '') + containerText;
                        } else {
                            // Try to get text from all child elements (spans)
                            const childText = Array.from(container.querySelectorAll('span, div'))
                                .map(el => el.innerText || el.textContent || '')
                                .filter(t => t.trim())
                                .join(' ');
                            if (childText.trim()) {
                                allText += (allText ? '\n\n' : '') + childText;
                            }
                        }
                    }
                    if (allText.trim()) {
                        return allText.trim();
                    }
                }
                
                // Also try looking for text in the entire document - check all divs for substantial text
                const allDivs = document.querySelectorAll('div');
                for (const div of allDivs) {
                    if (div.innerText && div.innerText.length > 500) {
                        // Check if this div is not visible (hidden/offscreen)
                        const rect = div.getBoundingClientRect();
                        const isVisible = rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
                        
                        if (isVisible) {
                            const text = div.innerText.trim();
                            // Make sure it's not just repeating the same word/character
                            if (text.length > 500 && text.split(/\s+/).length > 50) {
                                return text;
                            }
                        }
                    }
                }
                
                // Try PDF.js viewer - navigate through all pages
                const pdfViewer = document.querySelector('#viewer, .pdfViewer, canvas[data-page-number]');
                if (pdfViewer) {
                    const nextBtn = document.querySelector('#next, button[title*="Next"], button[title*="next"], .next, [aria-label*="Next"], [aria-label*="next"]');
                    const prevBtn = document.querySelector('#previous, button[title*="Previous"], button[title*="previous"], .previous');
                    
                    if (nextBtn) {
                        let maxPages = 1;
                        try {
                            const numPagesEl = document.querySelector('.numPages, #numPages, [data-total-pages]');
                            if (numPagesEl) {
                                maxPages = parseInt(numPagesEl.textContent || numPagesEl.getAttribute('data-total-pages')) || 100;
                            } else {
                                maxPages = 500;
                            }
                        } catch (e) {}

                        // Go to first page
                        if (prevBtn) {
                            for (let i = 0; i < 100; i++) {
                                if (prevBtn.disabled) break;
                                prevBtn.click();
                                const waitStart = Date.now();
                                while (Date.now() - waitStart < 200) {}
                            }
                        }

                        // Extract text from each page - try both TextLayer and body text
                        for (let page = 1; page <= Math.min(maxPages, 500); page++) {
                            // Scroll this specific page into view and trigger rendering
                            const pageEl = document.querySelector(`#page-${page - 1}, [data-page-number="${page}"], .Page:nth-child(${page})`);
                            if (pageEl) {
                                pageEl.scrollIntoView({behavior: 'instant', block: 'start'});
                                const scrollWait = Date.now();
                                while (Date.now() - scrollWait < 300) {}
                            }
                            
                            let pageText = '';
                            
                            // First try to get text from TextLayer for this page
                            const pageTextLayer = document.querySelector(`#page-${page - 1} .TextLayer-container, [data-page-number="${page}"] .TextLayer-container, .Page:nth-child(${page}) .TextLayer-container`);
                            if (pageTextLayer) {
                                pageText = pageTextLayer.innerText || pageTextLayer.textContent || '';
                            }
                            
                            // Fallback to body text if no TextLayer
                            if (!pageText.trim()) {
                                pageText = document.body.innerText || document.body.textContent || '';
                            }
                            
                            if (pageText && pageText.trim()) {
                                allText += (allText ? '\n\n' : '') + '--- Page ' + page + ' ---\n\n' + pageText;
                            }

                            if (page < maxPages && nextBtn && !nextBtn.disabled) {
                                try {
                                    nextBtn.click();
                                    const pageStart = Date.now();
                                    while (Date.now() - pageStart < 600) {}
                                    if (nextBtn.disabled) break;
                                } catch (e) {
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                        
                        if (allText.trim()) {
                            return allText.trim();
                        }
                    }
                }

                // Try iframe viewers and scroll through entire iframe
                const iframes = document.querySelectorAll('iframe, embed, object');
                for (const iframe of iframes) {
                    try {
                        if (iframe.contentDocument && iframe.contentDocument.body) {
                            const iframeBody = iframe.contentDocument.body;
                            const iframeWin = iframe.contentWindow;
                            
                            let lastScroll = 0;
                            let scrollCount = 0;
                            while (scrollCount < 100) {
                                iframeWin.scrollTo(0, iframeBody.scrollHeight);
                                const scrollStart = Date.now();
                                while (Date.now() - scrollStart < 300) {}
                                
                                if (iframeWin.scrollY === lastScroll) break;
                                lastScroll = iframeWin.scrollY;
                                scrollCount++;
                            }
                            
                            const iframeText = iframeBody.innerText || iframeBody.textContent || '';
                            if (iframeText.trim()) {
                                return iframeText.trim();
                            }
                        }
                    } catch (e) {}
                }

                // Scroll through content areas
                const contentArea = document.querySelector('#content, .file-content, .file-viewer, main, .file-view, [role="main"]');
                if (contentArea) {
                    let lastScroll = 0;
                    let scrollCount = 0;
                    while (scrollCount < 100) {
                        contentArea.scrollTop = contentArea.scrollHeight;
                        const scrollStart = Date.now();
                        while (Date.now() - scrollStart < 300) {}
                        
                        if (contentArea.scrollTop === lastScroll) break;
                        lastScroll = contentArea.scrollTop;
                        scrollCount++;
                    }
                    
                    const areaText = contentArea.innerText || contentArea.textContent || '';
                    if (areaText.trim()) {
                        return areaText.trim();
                    }
                }

                // Scroll entire page (matches scroll_to_bottom logic)
                let lastHeight = 0;
                let scrollSteps = 0;
                while (scrollSteps < 100) {
                    window.scrollTo(0, document.body.scrollHeight);
                    const scrollStart = Date.now();
                    while (Date.now() - scrollStart < 300) {}
                    
                    const newHeight = document.body.scrollHeight;
                    if (newHeight === lastHeight) break;
                    lastHeight = newHeight;
                    scrollSteps++;
                }

                return document.body.innerText || document.body.textContent || '';
            }, 1);

            return fileData || '';
        } catch (error) {
            return '';
        }
    }

    // crawl_course - EXACT Python workflow (lines 705-846)
    async crawlCourse(courseId, baseUrl, courseName) {
        const seeds = [
            baseUrl,
            `${baseUrl}/assignments`,
            `${baseUrl}/modules`,
            `${baseUrl}/assignments/syllabus`,
            `${baseUrl}/grades`,
            `${baseUrl}/announcements`
        ];

        // Hash visited pages (matches Python hashlib.md5 - using Set for simplicity)
        const visitedPagesH = new Set();
        const visitedFilesH = new Set();
        const queue = [...seeds];
        let steps = 0;

        // First: modules quick harvest of files (matches Python lines 726-757)
        // Skip module harvest in syllabus-only mode (we only want syllabus-specific content)
        if (this.syllabusOnlyMode) {
            console.log(`[SCRAPER]   Syllabus-only mode: skipping module harvest for course ${courseId}`);
        } else if (this.stopRequested) {
            console.log(`[SCRAPER]   Stop requested, skipping module harvest for course ${courseId}`);
        } else {
            try {
                // Navigate to modules
                await this.executeScriptOnPage(`${baseUrl}/modules`, () => {
                    // Navigation happens via tab creation
                });
                
                // Check for stop again
                if (this.stopRequested) {
                    console.log(`[SCRAPER]   Stop requested during module navigation for course ${courseId}`);
                } else {
                    // try_expand_all with timeout 5
                    await this.tryExpandAll(`${baseUrl}/modules`, 5);
                    await this.sleep(1000); // time.sleep(1.0)

                    // Find file links (matches Python XPath)
                    const moduleFileLinks = await this.executeScriptOnPage(`${baseUrl}/modules`, () => {
                        const anchors = Array.from(document.querySelectorAll('a[href]'));
                        return anchors
                            .map(a => ({
                                href: a.href,
                                text: (a.textContent || '').trim(),
                                title: (a.getAttribute('title') || '').trim()
                            }))
                            .filter(linkMeta => {
                                const h = (linkMeta.href || '').toLowerCase();
                                return h.includes('/files/') || 
                                       h.includes('.pdf') || 
                                       h.includes('.docx') || 
                                       h.includes('.pptx') || 
                                       h.includes('.xlsx') || 
                                       h.includes('.csv');
                            });
                    });

                    const seenFiles = new Set();
                    for (const linkMeta of moduleFileLinks) {
                        // Check for stop before each file
                        if (this.stopRequested) break;
                        
                        const href = linkMeta.href;
                        // In syllabus-only mode, check URL, link text, and title for "syllabus"
                        if (this.syllabusOnlyMode) {
                            const hasSyllabus = href.toLowerCase().includes('syllabus') ||
                                                linkMeta.text.toLowerCase().includes('syllabus') ||
                                                linkMeta.title.toLowerCase().includes('syllabus');
                            if (!hasSyllabus) {
                                console.log(`[SCRAPER]   Skipping non-syllabus file in syllabus-only mode: ${href}`);
                                continue;
                            }
                        }
                        
                        if (href.includes('/files/') && !seenFiles.has(href)) {
                            seenFiles.add(href);
                            const link = this.normalizeLink(href, courseId);
                            if (link) {
                                try {
                                    const fileContent = await this.extractFileFromCanvas(link);
                                    if (fileContent && fileContent.length >= this.MIN_TEXT_LEN_TO_RECORD) {
                                        const fileName = link.split('/').pop() || 'file';
                                        const fileKey = `file_${visitedFilesH.size + 1}_${fileName.substring(0, 30)}`;
                                        const content = fileContent.substring(0, this.MAX_FILE_CHARS);
                                        
                                        visitedFilesH.add(link);
                                        
                                        // Skip if URL was already scraped in previous sessions
                                        if (this.scrapedUrls && this.scrapedUrls.has(link)) {
                                            console.log(`[SCRAPER]   Skipping already-scraped file: ${link}`);
                                            continue;
                                        }
                                        
                                        this.coursesData[courseId].pages[fileKey] = {
                                            url: link,
                                            content: content,
                                            textLength: fileContent.length,
                                            title: fileName,
                                            type: 'file'
                                        };
                                        
                                        // Track this URL as scraped
                                        if (this.scrapedUrls) {
                                            this.scrapedUrls.add(link);
                                        }
                                        
                                        console.log(`[SCRAPER]   [file] saved ${fileName} (${fileContent.length} chars) from ${link}`);
                                    }
                                } catch (e) {
                                    // Suppress exceptions (matches Python contextlib.suppress)
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // Suppress exceptions
            }
        }

        // BFS crawl (matches Python while loop lines 764-837)
        // CRITICAL: Each iteration does ALL operations in ONE script execution
        // so expand → scroll → collect links all happen on the same page state
        while (queue.length > 0 && visitedPagesH.size < this.MAX_LINKS_PER_COURSE) {
            const url = queue.shift();
            
            // Skip if already visited in this session
            if (visitedPagesH.has(url)) {
                continue;
            }
            
            // Skip if URL was already scraped in previous sessions
            if (this.scrapedUrls && this.scrapedUrls.has(url)) {
                console.log(`[SCRAPER]   Skipping already-scraped URL: ${url}`);
                continue;
            }
            
            visitedPagesH.add(url);

            try {
                // EXACT Python workflow in ONE script execution:
                // driver.get(url) → try_expand_all → sleep(0.6) → scroll_to_bottom → get_visible_text → collect_in_course_links
                const pageData = await this.executeScriptOnPage(url, () => {
                    // Step 1: try_expand_all (matches Python lines 773)
                    try {
                        const btn = document.getElementById('expand_collapse_all');
                        if (btn) {
                            const aria = (btn.getAttribute('aria-expanded') || '').trim().toLowerCase();
                            const de = (btn.getAttribute('data-expand') || '').trim().toLowerCase();
                            const shouldClick = (aria === 'false') || (de === 'false') || (!aria && !de);
                            if (shouldClick) {
                                btn.click();
                                // Wait for expansion (matches Python WebDriverWait)
                                const startTime = Date.now();
                                while (Date.now() - startTime < 5000) {
                                    const currentAria = (btn.getAttribute('aria-expanded') || '').trim().toLowerCase();
                                    const currentDe = (btn.getAttribute('data-expand') || '').trim().toLowerCase();
                                    if (currentAria === 'true' || currentDe === 'true') break;
                                }
                            }
                        }
                    } catch (e) {}

                    // Step 2: time.sleep(0.6) - wait 600ms (matches Python line 774)
                    const waitStart = Date.now();
                    while (Date.now() - waitStart < 600) {}

                    // Step 3: scroll_to_bottom - BOTH window AND internal containers
                    // First scroll internal containers like .Pages for Canvas PDF viewers
                    const internalContainers = document.querySelectorAll('.Pages, [class*="Pages"], .content, [class*="content"]');
                    for (const container of internalContainers) {
                        let lastScroll = 0;
                        for (let j = 0; j < 12; j++) {
                            container.scrollTop = container.scrollHeight;
                            const scrollStart = Date.now();
                            while (Date.now() - scrollStart < 200) {}
                            
                            if (container.scrollTop === lastScroll) break;
                            lastScroll = container.scrollTop;
                        }
                        // Reset to top after scrolling
                        container.scrollTop = 0;
                    }
                    
                    // Then scroll window
                    let lastH = 0;
                    for (let i = 0; i < 12; i++) {
                        window.scrollTo(0, document.body.scrollHeight);
                        // Wait pause seconds (matches time.sleep)
                        const scrollStart = Date.now();
                        while (Date.now() - scrollStart < 300) {}
                        
                        const h = document.body.scrollHeight;
                        if (h === lastH) break;
                        lastH = h;
                    }

                    // Step 4: get_visible_text (matches Python lines 777-778)
                    // Try to extract text from Canvas PDF viewers (TextLayer) first
                    let pageText = '';
                    
                    // Prioritize .textLayer elements inside .TextLayer-container, then fall back to container itself
                    const textLayerElements = document.querySelectorAll('.TextLayer-container .textLayer, .textLayer');
                    if (textLayerElements.length > 0) {
                        // Get text from .textLayer elements (these contain the actual text)
                        for (const layer of textLayerElements) {
                            const layerText = layer.innerText || layer.textContent || '';
                            if (layerText.trim()) {
                                pageText += (pageText ? '\n\n' : '') + layerText;
                            }
                        }
                    }
                    
                    // Fallback: try TextLayer-container directly if no .textLayer found
                    if (!pageText.trim()) {
                        const textLayerContainers = document.querySelectorAll('.TextLayer-container, [class*="TextLayer-container"]');
                        if (textLayerContainers.length > 0) {
                            for (const container of textLayerContainers) {
                                // Try to get text from the container itself
                                const containerText = container.innerText || container.textContent || '';
                                if (containerText.trim()) {
                                    pageText += (pageText ? '\n\n' : '') + containerText;
                                } else {
                                    // Try to get text from all child elements (spans)
                                    const childText = Array.from(container.querySelectorAll('span, div'))
                                        .map(el => el.innerText || el.textContent || '')
                                        .filter(t => t.trim())
                                        .join(' ');
                                    if (childText.trim()) {
                                        pageText += (pageText ? '\n\n' : '') + childText;
                                    }
                                }
                            }
                        }
                    }
                    
                    // Fallback to body text if no TextLayer found
                    if (!pageText.trim()) {
                        pageText = (document.body && document.body.innerText) ? document.body.innerText : '';
                        if (!pageText) {
                            pageText = document.body ? document.body.textContent || '' : '';
                        }
                    }
                    // Normalize whitespace (matches Python re.sub)
                    pageText = pageText.replace(/[ \t\r\f\v]+/g, ' ');
                    pageText = pageText.replace(/\n\s*\n+/g, '\n\n');
                    pageText = pageText.trim();

                    // Step 5: collect_in_course_links (matches Python line 799)
                    // This happens AFTER expansion and scrolling, so ALL links (including dropdown links) are visible
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    const linksWithMetadata = anchors.map(a => ({
                        href: a.href,
                        text: (a.textContent || '').trim(),
                        title: (a.getAttribute('title') || '').trim()
                    }));

                    return {
                        text: pageText,
                        links: linksWithMetadata,
                        html: document.body.innerHTML.substring(0, 50000),
                        title: document.title
                    };
                });

                // Process page text (matches Python lines 779-796)
                if (pageData && pageData.text) {
                    let truncated = false;
                    let textToSave = pageData.text;
                    if (this.MAX_PAGE_CHARS && pageData.text.length > this.MAX_PAGE_CHARS) {
                        textToSave = pageData.text.substring(0, this.MAX_PAGE_CHARS);
                        truncated = true;
                    }

                    if (textToSave.length >= this.MIN_TEXT_LEN_TO_RECORD) {
                        // Generate unique key
                        const urlPath = new URL(url).pathname;
                        const pathParts = urlPath.split('/').filter(p => p);
                        let pageKey = pathParts[pathParts.length - 1] || 'page';
                        if (!pageKey || pageKey === courseId) {
                            pageKey = pathParts[pathParts.length - 2] || 'index';
                        }
                        let uniqueKey = pageKey;
                        let counter = 1;
                        while (this.coursesData[courseId].pages[uniqueKey]) {
                            uniqueKey = `${pageKey}_${counter}`;
                            counter++;
                        }

                        this.coursesData[courseId].pages[uniqueKey] = {
                            url: url,
                            content: textToSave,
                    textLength: pageData.text.length,
                            title: pageData.title || '',
                            type: 'page',
                            truncated: truncated
                        };
                        
                        // Track this URL as scraped
                        if (this.scrapedUrls) {
                            this.scrapedUrls.add(url);
                        }
                        
                        console.log(`[SCRAPER]   [page] ${url} -> ${pageData.text.length} chars${truncated ? ' (truncated)' : ''}`);
                    }
                }

                // Process discovered links (from expanded dropdowns!)
                if (pageData && pageData.links) {
                    // Normalize all links (matches Python normalize_link)
                    // pageData.links is now an array of objects with href, text, title
                    const normalizedLinks = new Map(); // Use Map to store URL -> metadata mapping
                    for (const rawLink of pageData.links) {
                        // Extract href (could be string or object)
                        const href = typeof rawLink === 'string' ? rawLink : (rawLink.href || '');
                        const linkText = typeof rawLink === 'string' ? '' : (rawLink.text || '');
                        const linkTitle = typeof rawLink === 'string' ? '' : (rawLink.title || '');
                        
                        const norm = this.normalizeLink(href, courseId);
                        if (norm) {
                            normalizedLinks.set(norm, { text: linkText, title: linkTitle });
                        }
                    }

                    // Process each link (matches Python lines 800-834)
                    for (const [link, metadata] of normalizedLinks) {
                        // Check if file (matches Python is_file logic lines 801-805)
                        const isFile = link.includes('/files/') ||
                            this.ALLOWED_EXT_FOR_EXTRACTION.some(ext => link.toLowerCase().endsWith(ext)) ||
                            link.toLowerCase().includes('/download');

                        if (isFile) {
                            // In syllabus-only mode, check URL, link text, and title for "syllabus"
                            if (this.syllabusOnlyMode) {
                                const hasSyllabus = link.toLowerCase().includes('syllabus') ||
                                                    metadata.text.toLowerCase().includes('syllabus') ||
                                                    metadata.title.toLowerCase().includes('syllabus');
                                if (!hasSyllabus) {
                                    console.log(`[SCRAPER]   Skipping non-syllabus file in syllabus-only mode: ${link}`);
                                    continue;
                                }
                            }
                            
                            if (visitedFilesH.has(link)) {
                                continue;
                            }
                            visitedFilesH.add(link);

                            try {
                                const fileContent = await this.extractFileFromCanvas(link);
                                if (fileContent && fileContent.length >= this.MIN_TEXT_LEN_TO_RECORD) {
                                    const fileName = link.split('/').pop() || 'file';
                                    const fileKey = `file_${visitedFilesH.size}_${fileName.substring(0, 30)}`;
                                    const content = fileContent.substring(0, this.MAX_FILE_CHARS);
                                    
                                    this.coursesData[courseId].pages[fileKey] = {
                                        url: link,
                                        content: content,
                                        textLength: fileContent.length,
                                        title: fileName,
                                        type: 'file'
                                    };
                                    
                                    // Track this URL as scraped
                                    if (this.scrapedUrls) {
                                        this.scrapedUrls.add(link);
                                    }
                                    
                                    console.log(`[SCRAPER]   [file] saved ${fileName} (${fileContent.length} chars) from ${link}`);
                                }
                            } catch (e) {
                                // Suppress exceptions
                            }
                        } else {
                            // Add non-file links to queue based on mode
                            // If syllabus-only mode: check URL, link text, and title for "syllabus"
                            const shouldAdd = this.syllabusOnlyMode ? 
                                (link.toLowerCase().includes('syllabus') ||
                                 metadata.text.toLowerCase().includes('syllabus') ||
                                 metadata.title.toLowerCase().includes('syllabus')) : true;
                            
                            if (shouldAdd && visitedPagesH.size + queue.length < this.MAX_LINKS_PER_COURSE) {
                                queue.push(link);
                                console.log(`[SCRAPER]   Added link to queue: ${link}`);
                            } else if (!shouldAdd) {
                                console.log(`[SCRAPER]   Skipping non-syllabus link in syllabus-only mode: ${link}`);
                            }
                        }
                    }
                }

            } catch (e) {
                // Suppress exceptions (matches Python line 836-837)
                console.warn(`[SCRAPER]   Error crawling ${url}:`, e.message);
                
                // "Tab editing blocked" is critical - restart immediately on any occurrence
                if (e.message && e.message.includes('Tab editing blocked')) {
                    console.log(`[SCRAPER]   Critical: Tab editing blocked detected, will trigger restart`);
                    // Set count to 2 to trigger restart immediately
                    this.errorPageErrorCount = 2;
                    this.lastErrorPageError = Date.now();
                } else {
                    // Track consecutive errors for other restartable errors (error page, tab removal, etc.)
                    const isRestartableError = e.message && (
                        e.message.includes('error page') ||
                        e.message.includes('No tab with id')
                    );
                    
                    if (isRestartableError) {
                        const now = Date.now();
                        if (this.lastErrorPageError && (now - this.lastErrorPageError) < 10000) {
                            // Error within 10 seconds of last error = consecutive error
                            this.errorPageErrorCount++;
                        } else {
                            // First error or gap > 10 seconds = reset counter
                            this.errorPageErrorCount = 1;
                        }
                        this.lastErrorPageError = now;
                        
                        console.log(`[SCRAPER]   Restartable error count: ${this.errorPageErrorCount}`);
                    }
                }
            }

            steps++;
            if (steps % 10 === 0) {
                console.log(`[SCRAPER] Crawled ${visitedPagesH.size} pages and ${visitedFilesH.size} file endpoints in course ${courseId}`);
            }
        }

        console.log(`[SCRAPER] [course done] ${courseId}: ${visitedPagesH.size} pages, ${visitedFilesH.size} file endpoints`);
    }

    // Scrape a single course - matches run_course_crawl
    async scrapeCourse(courseId) {
        // Safety check: skip excluded courses
        if (this.excludedCourseIds.includes(courseId)) {
            console.log(`[SCRAPER] Skipping excluded course ${courseId}`);
            return;
        }

        console.log(`[SCRAPER] Scraping course ${courseId}...`);

        // Use exact Python workflow
        await this.runCourseCrawl(courseId);

        console.log(`[SCRAPER]   Completed course ${courseId}`);
    }

    // Extract course name from page data
    extractCourseName(pageData, courseId) {
        // Try to find course title in page title
        if (pageData.title) {
            // Remove "Canvas" and other common suffixes
            let name = pageData.title.replace(/\s*-\s*Canvas.*$/i, '').trim();
            if (name && name !== 'Dashboard') {
                return name;
            }
        }

        // Try to find in text
        const lines = pageData.text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            // Look for lines that look like course names (contain letters and numbers)
            if (trimmed.length > 5 && trimmed.length < 100 && /[A-Z]/.test(trimmed) && /\d/.test(trimmed)) {
                return trimmed;
            }
        }

        return `Course ${courseId}`;
    }

    // Execute script on a specific page (with retry for tab editing errors)
    async executeScriptOnPage(url, scriptFunc, retries = 0) {
        let lastError = null;
        const maxRetries = 3;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this._executeScriptOnPageAttempt(url, scriptFunc, attempt);
            } catch (error) {
                lastError = error;
                
                // Check if it's a tab editing error that should be retried
                if (error.message && error.message.includes('TAB_EDITING_BLOCKED')) {
                    if (attempt < maxRetries) {
                        console.log(`[SCRAPER] Tab editing blocked, waiting before retry ${attempt + 1}/${maxRetries}...`);
                        
                        // Close any tabs in the target window that might be stuck
                        try {
                            if (this.targetWindowId) {
                                const tabs = await new Promise((resolve) => {
                                    chrome.tabs.query({windowId: this.targetWindowId}, resolve);
                                });
                                for (const tab of tabs) {
                                    try {
                                        await chrome.tabs.remove(tab.id);
                                    } catch (e) {
                                        // Ignore errors closing tabs
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore errors
                        }
                        
                        // Wait progressively longer between retries (1s, 2s, 3s)
                        await this.sleep(1000 * (attempt + 1));
                        continue;
                    }
                }
                
                // For other errors or max retries reached, throw
                throw error;
            }
        }
        
        throw lastError;
    }

    // Single attempt to execute script on a page
    async _executeScriptOnPageAttempt(url, scriptFunc, attemptNumber) {
        return new Promise((resolve, reject) => {
            console.log(`[SCRAPER]     Opening: ${url}`);

            const createOptions = { 
                url: url, 
                active: false,
                // Keep at least some tabs visible to prevent sleep
                pinned: false
            };
            if (this.targetWindowId) {
                createOptions.windowId = this.targetWindowId;
            }

            chrome.tabs.create(createOptions, (tab) => {
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message;
                    // Check if it's a tab editing error that can be retried
                    if (errorMsg && errorMsg.includes('Tabs cannot be edited') && errorMsg.includes('dragging')) {
                        console.log('[SCRAPER] Tab editing blocked (user may be dragging tab). Will retry after delay...');
                        // This error will be caught and retried at a higher level
                        reject(new Error('TAB_EDITING_BLOCKED: ' + errorMsg));
                        return;
                    }
                    reject(new Error(errorMsg));
                    return;
                }

                let resolved = false;
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        // Close tab, ignoring tab editing errors
                        chrome.tabs.remove(tab.id).catch((e) => {
                            // Ignore tab editing errors
                            if (!e.message || !e.message.includes('Tabs cannot be edited')) {
                                console.warn('[SCRAPER] Error closing tab on timeout:', e.message);
                            }
                        });
                        reject(new Error('Page load timeout'));
                    }
                }, 60000);

                // ADD: Periodically update tab to keep it active
                const keepAliveInterval = setInterval(() => {
                    if (!resolved) {
                        chrome.tabs.update(tab.id, {active: false}, () => {
                            // Ignore tab editing errors (user might be dragging tabs)
                            if (chrome.runtime.lastError && 
                                chrome.runtime.lastError.message && 
                                chrome.runtime.lastError.message.includes('Tabs cannot be edited')) {
                                // Silently ignore - this is expected if user is interacting with tabs
                            }
                        });
                    }
                }, 10000); // Every 10 seconds
                
                // Clear interval when done
                const originalResolve = resolve;
                resolve = (value) => {
                    clearInterval(keepAliveInterval);
                    originalResolve(value);
                };

                const listener = async (tabId, changeInfo, tabInfo) => {
                    // Only process when status is complete and we haven't resolved yet
                    if (tabId === tab.id && changeInfo.status === 'complete' && !resolved) {
                        // Don't resolve yet - we need to verify the page is valid first
                        clearTimeout(timeoutId);

                        // Check if page is an error page before executing script
                        try {
                            const currentTab = await new Promise((resolve, reject) => {
                                chrome.tabs.get(tab.id, (tabData) => {
                                    if (chrome.runtime.lastError) {
                                        reject(new Error(chrome.runtime.lastError.message));
                                    } else {
                                        resolve(tabData);
                                    }
                                });
                            });

                            // Check for error page URLs
                            const errorPagePatterns = [
                                /^chrome-error:/,
                                /^chrome:\/\/error/,
                                /^chrome:\/\/crash/,
                                /^about:error/
                            ];

                            const isErrorPage = errorPagePatterns.some(pattern => 
                                pattern.test(currentTab.url || '')
                            );

                            if (isErrorPage) {
                                // Close tab, ignoring tab editing errors
                                chrome.tabs.remove(tab.id).catch((e) => {
                                    if (!e.message || !e.message.includes('Tabs cannot be edited')) {
                                        console.warn('[SCRAPER] Error closing error page tab:', e.message);
                                    }
                                });
                                reject(new Error(`Page is showing an error: ${currentTab.url}`));
                                return;
                            }

                            // Additional check: verify the page actually loaded
                            if (!currentTab.url || currentTab.url.startsWith('chrome-error:')) {
                                // Close tab, ignoring tab editing errors
                                chrome.tabs.remove(tab.id).catch((e) => {
                                    if (!e.message || !e.message.includes('Tabs cannot be edited')) {
                                        console.warn('[SCRAPER] Error closing failed page tab:', e.message);
                                    }
                                });
                                reject(new Error(`Failed to load page: ${currentTab.url || 'unknown URL'}`));
                                return;
                            }

                            // Check if we're redirected away from Canvas (might indicate auth issue)
                            const expectedDomain = 'canvas.cornell.edu';
                            if (!currentTab.url.includes(expectedDomain) && 
                                !currentTab.url.startsWith('chrome://') &&
                                !currentTab.url.startsWith('chrome-error:')) {
                                console.warn(`[SCRAPER]     Page redirected from expected domain. Expected ${expectedDomain}, got: ${currentTab.url}`);
                                // Don't fail here - might be legitimate redirect, but log it
                            }

                            // Small delay to ensure DOM is ready
                            await this.sleep(500);

                            // Mark as resolved before attempting script execution
                        resolved = true;
                        chrome.tabs.onUpdated.removeListener(listener);

                        chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: scriptFunc
                        }).then((results) => {
                            // Close tab, ignoring tab editing errors
                            chrome.tabs.remove(tab.id).catch((e) => {
                                // Ignore tab editing errors - tab might be closed already or user dragging
                                if (!e.message || !e.message.includes('Tabs cannot be edited')) {
                                    console.warn('[SCRAPER] Error closing tab:', e.message);
                                }
                            });
                            if (results && results[0] && results[0].result !== undefined) {
                                resolve(results[0].result);
                            } else {
                                reject(new Error('No result from script'));
                            }
                        }).catch((error) => {
                            // Close tab, ignoring tab editing errors
                            chrome.tabs.remove(tab.id).catch((e) => {
                                // Ignore tab editing errors
                                if (!e.message || !e.message.includes('Tabs cannot be edited')) {
                                    console.warn('[SCRAPER] Error closing tab:', e.message);
                                }
                            });
                                // Check if it's the specific error page error
                                if (error.message && (error.message.includes('error page') || 
                                    error.message.includes('Frame with ID'))) {
                                    reject(new Error(`Cannot execute script on error page: ${currentTab.url || url}`));
                                } else {
                            reject(error);
                                }
                            });
                        } catch (checkError) {
                            if (!resolved) {
                                resolved = true;
                                chrome.tabs.onUpdated.removeListener(listener);
                            }
                            chrome.tabs.remove(tab.id).catch(() => {});
                            reject(new Error(`Failed to check tab status: ${checkError.message}`));
                        }
                    }
                };

                chrome.tabs.onUpdated.addListener(listener);
            });
        });
    }

    // Save data to chrome.storage.local and upload to backend
    async saveScrapedData() {
        // Save to local storage first
        const dataToSave = {
            courses: this.coursesData,
            lastScraped: Date.now(),
            version: '2.0'
        };

        await new Promise((resolve, reject) => {
            chrome.storage.local.set({ canvasData: dataToSave }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    console.log('[SCRAPER] Data saved to chrome.storage.local');
                    resolve();
                }
            });
        });

        // Data saved locally - no upload needed
        this.sendProgress('✓ Data saved locally in browser storage');
    }

    // Get scraped data
    async getScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['canvasData'], (result) => {
                resolve(result.canvasData || null);
            });
        });
    }

    // Clear scraped data
    async clearScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.remove(['canvasData'], () => {
                console.log('[SCRAPER] Data cleared');
                resolve();
            });
        });
    }

    // Send progress update
    sendProgress(message) {
        console.log(`[SCRAPER PROGRESS] ${message}`);
        if (this.progressCallback) {
            this.progressCallback(message);
        }
    }

    // Remove all HTML elements (text between <> tags) from the corpus
    removeHtmlFromCorpus(coursesData) {
        console.log('[SCRAPER] Removing HTML elements from corpus...');
        let cleanedCount = 0;
        
        for (const courseId in coursesData) {
            const course = coursesData[courseId];
            if (course.pages) {
                for (const pageName in course.pages) {
                    const page = course.pages[pageName];
                    if (page.content) {
                        // Remove all HTML tags and their content
                        // This regex removes everything between < and > tags
                        const originalLength = page.content.length;
                        page.content = page.content.replace(/<[^>]*>/g, '');
                        // Also clean up any remaining HTML entities
                        page.content = page.content
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'")
                            .replace(/&apos;/g, "'");
                        // Normalize whitespace (multiple spaces/newlines to single)
                        page.content = page.content.replace(/\s+/g, ' ').trim();
                        page.textLength = page.content.length;
                        cleanedCount++;
                        console.log(`[SCRAPER]   Cleaned ${pageName} for course ${courseId}: ${originalLength} -> ${page.content.length} chars`);
                    }
                }
            }
        }
        
        console.log(`[SCRAPER] HTML removal complete. Cleaned ${cleanedCount} pages.`);
    }

    // Helper: sleep
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Format corpus as plain text for GPT API
    formatCorpusForGPT(coursesData) {
        let corpusText = '';
        for (const courseId in coursesData) {
            const course = coursesData[courseId];
            corpusText += `\n\n=== Course: ${course.name} (ID: ${courseId}) ===\n\n`;
            if (course.pages) {
                for (const pageName in course.pages) {
                    const page = course.pages[pageName];
                    corpusText += `\n--- ${pageName} ---\n`;
                    corpusText += page.content || '';
                    corpusText += '\n';
                }
            }
        }
        return corpusText.trim();
    }

    // Process a single batch through GPT API
    async processGPTSingleBatch(apiKey, batchText, batchNum, totalBatches) {
        const batchPrompt = `Here's unstructured output for a scraper that's scraping a user's courses from canvas. I want you to structure the output to make it super readable and retrievable for an AI. You MUST respond with approximately 120,000 tokens (~480,000 characters) while keeping all the information intact for each course. Remove artifacts of html scraping and keep the content. Try to keep important content like assignments and dates of upcoming assignments/tests as well as syllabi over less important content but if you have space include it all.

CRITICAL FORMAT REQUIREMENT: You MUST format your response using EXACTLY this format for each course:

=== Course: [COURSE_NAME] (ID: [COURSE_ID]) ===

[Course content here]

=== Course: [NEXT_COURSE_NAME] (ID: [NEXT_COURSE_ID]) ===

[NEXT Course content here]

You MUST:
1. Use exactly "=== Course: " at the start of each course marker
2. Include the course name exactly as shown in the input
3. Include " (ID: " followed by the course ID number
4. End each marker with exactly ") ==="
5. Do NOT add any other text before the first course marker
6. Do NOT add any text after the last course marker
7. Separate each course clearly with these exact markers

Group the scattered information into coherent courses. Mention the course's name / ID constantly throughout a course's processed text.

${totalBatches > 1 ? `\n\nNOTE: This is batch ${batchNum} of ${totalBatches}. Only structure the content provided below.\n\n` : ''}

Here is the content to structure:\n\n${batchText}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5-nano', // As requested by user, but will use gpt-4o-mini in practice
                messages: [
                    {
                        role: 'user',
                        content: batchPrompt
                    }
                ]
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }

        const data = await response.json();
        const restructuredContent = data.choices[0].message.content.trim();
        
        if (!restructuredContent) {
            throw new Error(`GPT API returned empty content for batch ${batchNum}`);
        }

        console.log(`[SCRAPER] Batch ${batchNum}/${totalBatches} processed (${restructuredContent.length} characters)`);
        return restructuredContent;
    }

    // Restructure corpus using GPT API
    async restructureCorpusWithGPT(coursesData) {
        // Get API key from storage
        return new Promise((resolve, reject) => {
            chrome.storage.sync.get(['openaiApiKey'], async (result) => {
                const apiKey = result.openaiApiKey;
                if (!apiKey) {
                    reject(new Error('OpenAI API key not found. Please configure it in extension settings.'));
                    return;
                }

                try {
                    // Format corpus as text
                    const corpusText = this.formatCorpusForGPT(coursesData);
                    const charCount = corpusText.length;
                    console.log(`[SCRAPER] Corpus text length: ${charCount} characters`);
                    
                    // Calculate number of batches needed (400K chars per batch)
                    // Formula: (charCount / 1600000) + 1 (ceiling division)
                    // Actually, user said "divide by mod 4, add 1" - so charCount / 400000, rounded up
                    const maxCharsPerBatch = 1600000; // 400K tokens * 4 chars per token
                    const numBatches = Math.ceil(charCount / maxCharsPerBatch);
                    console.log(`[SCRAPER] Splitting into ${numBatches} batch(es) for GPT processing`);
                    
                    let allRestructuredContent = '';
                    
                    if (numBatches > 1) {
                        // Split corpus into batches and process each separately
                        console.log(`[SCRAPER] Processing in ${numBatches} batches due to large corpus size...`);
                        
                        for (let batchNum = 0; batchNum < numBatches; batchNum++) {
                            const startIdx = batchNum * maxCharsPerBatch;
                            const endIdx = Math.min(startIdx + maxCharsPerBatch, charCount);
                            const batchText = corpusText.substring(startIdx, endIdx);
                            
                            this.sendProgress(`Processing GPT batch ${batchNum + 1}/${numBatches}...`);
                            console.log(`[SCRAPER] Processing batch ${batchNum + 1}/${numBatches} (${batchText.length} chars)...`);
                            
                            const batchContent = await this.processGPTSingleBatch(apiKey, batchText, batchNum + 1, numBatches);
                            allRestructuredContent += batchContent + '\n\n';
                            
                            // Small delay between batches to avoid rate limiting
                            await this.sleep(1000);
                        }
                        
                        console.log(`[SCRAPER] All ${numBatches} batches processed. Total restructured content: ${allRestructuredContent.length} characters`);
                    } else {
                        // Single batch - original logic
                        console.log(`[SCRAPER] Sending corpus to GPT API (${charCount} characters)...`);
                        allRestructuredContent = await this.processGPTSingleBatch(apiKey, corpusText, 1, 1);
                    }
                    
                    const restructuredContent = allRestructuredContent.trim();

                    if (!restructuredContent) {
                        throw new Error('GPT API returned empty content');
                    }

                    console.log(`[SCRAPER] Received restructured content (${restructuredContent.length} characters) from ${numBatches} batch(es)`);

                    // Parse the restructured content back into coursesData format
                    // We'll create a single page per course with the restructured content
                    const restructuredCoursesData = {};
                    const coursePattern = /=== Course: ([^(]+) \(ID: ([^)]+)\) ===/g;
                    let lastIndex = 0;
                    let match;

                    while ((match = coursePattern.exec(restructuredContent)) !== null) {
                        const courseName = match[1].trim();
                        const courseId = match[2].trim();
                        const courseStart = match.index + match[0].length;

                        // Find next course start or end of content
                        coursePattern.lastIndex = match.index + match[0].length;
                        const nextMatch = coursePattern.exec(restructuredContent);
                        const courseEnd = nextMatch ? nextMatch.index : restructuredContent.length;
                        coursePattern.lastIndex = match.index + match[0].length; // Reset for next iteration

                        const courseContent = restructuredContent.substring(courseStart, courseEnd).trim();

                        // If this course exists in original data, preserve structure
                        if (coursesData[courseId]) {
                            restructuredCoursesData[courseId] = {
                                id: courseId,
                                name: courseName,
                                pages: {
                                    restructured: {
                                        url: '',
                                        content: courseContent,
                                        textLength: courseContent.length,
                                        title: 'Restructured Content',
                                        type: 'restructured'
                                    }
                                },
                                scrapedAt: coursesData[courseId].scrapedAt
                            };
                        }
                    }

                    // If parsing failed (no course markers), store as single restructured entry per course
                    if (Object.keys(restructuredCoursesData).length === 0) {
                        console.warn('[SCRAPER] Could not parse restructured content with course markers, storing as single restructured entry');
                        for (const courseId in coursesData) {
                            const course = coursesData[courseId];
                            restructuredCoursesData[courseId] = {
                                id: courseId,
                                name: course.name,
                                pages: {
                                    restructured: {
                                        url: '',
                                        content: restructuredContent,
                                        textLength: restructuredContent.length,
                                        title: 'Restructured Content',
                                        type: 'restructured'
                                    }
                                },
                                scrapedAt: course.scrapedAt
                            };
                        }
                    }

                    // Replace original coursesData with restructured version
                    Object.keys(coursesData).forEach(courseId => {
                        if (restructuredCoursesData[courseId]) {
                            coursesData[courseId] = restructuredCoursesData[courseId];
                        }
                    });

                    console.log('[SCRAPER] Corpus restructured successfully');
                    resolve();
                } catch (error) {
                    console.error('[SCRAPER] Error restructuring corpus:', error);
                    reject(error);
                }
            });
        });
    }

    startKeepAwake() {
        // Clear any existing interval
        if (this.keepAwakeInterval) {
            clearInterval(this.keepAwakeInterval);
        }
        
        // Keep system active by periodically creating small activity
        // This prevents Chrome from going idle during long scraping sessions
        this.keepAwakeInterval = setInterval(() => {
            try {
                // Method 1: Periodically update a visible tab (if available)
                chrome.tabs.query({windowId: this.targetWindowId, active: true}, (tabs) => {
                    if (tabs && tabs.length > 0) {
                        // Activate a tab to keep Chrome active
                        chrome.tabs.update(tabs[0].id, {active: false}, () => {
                            // Small delay then reactivate
                            setTimeout(() => {
                                chrome.tabs.update(tabs[0].id, {active: true});
                            }, 50);
                        });
                    }
                });
                
                // Method 2: Create small storage write (keeps background active)
                chrome.storage.local.set({
                    _keepAwake: Date.now()
                }, () => {});
                
                // Method 3: Send progress update (if callback exists)
                if (this.progressCallback) {
                    // Silent heartbeat - doesn't show to user but keeps things active
                    this.progressCallback('heartbeat', '');
                }
            } catch (e) {
                // Ignore errors
            }
        }, 30000); // Every 30 seconds - prevents system from going to sleep
        
        console.log('[SCRAPER] Keep-awake mechanism started');
    }

    stopKeepAwake() {
        if (this.keepAwakeInterval) {
            clearInterval(this.keepAwakeInterval);
            this.keepAwakeInterval = null;
            console.log('[SCRAPER] Keep-awake mechanism stopped');
        }
    }
}
