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
        
        // Tab management - persistent tabs per course
        this.courseTabs = new Map();
        
        // Scraping state (from scraper-core.js)
        this.visitedURLs = new Set();
        this.linkQueue = [];
    }
    
    // ===== INFRASTRUCTURE METHODS (KEPT FROM ORIGINAL) =====
    
    async stopScraping() {
        console.log('[SCRAPER-OLD] Stop requested by user');
        this.stopRequested = true;
        
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
        this.visitedURLs.clear();
        this.linkQueue = [];

        this.startKeepAwake();

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

            // Step 2: Scrape all courses in parallel
            this.stopRequested = false;
            this.activeScrapingPromises = [];
            
            let completedCourses = 0;
            const totalCourses = courseIds.length;
            this.sendProgress(`progress:${completedCourses}/${totalCourses}`);
            
            const courseScrapingPromises = courseIds.map((courseId) => {
                const operationId = `course_${courseId}_${Date.now()}`;
                this.activeOperations.set(operationId, `Scraping course ${courseId}`);
                
                const promise = (async () => {
                    try {
                        this.currentCourseContext = {
                            courseId: courseId,
                            courseName: this.coursesData[courseId]?.name,
                            completedCourses: completedCourses,
                            totalCourses: totalCourses
                        };
                        
                        return await this.scrapeCourse(courseId);
                    } catch (error) {
                        if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                            return 'RESTART_REQUIRED';
                        }
                        
                        this.logDetailedError({
                            errorType: 'COURSE_SCRAPING_ERROR',
                            errorMessage: error.message || 'Unknown error',
                            errorStack: error.stack,
                            courseId: courseId,
                            courseName: this.coursesData[courseId]?.name,
                            operation: 'scrapeCourse',
                            completedCourses: completedCourses,
                            totalCourses: totalCourses,
                            currentPhase: 'course_scraping'
                        });
                        
                        return null;
                    } finally {
                        this.activeOperations.delete(operationId);
                        completedCourses++;
                        this.sendProgress(`progress:${completedCourses}/${totalCourses}`);
                    }
                })();
                
                this.activeScrapingPromises.push(promise);
                return promise;
            });

            await Promise.allSettled(courseScrapingPromises);
            
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
            console.log(`[SCRAPER-OLD] Skipping excluded course ${courseId}`);
            return;
        }

        console.log(`[SCRAPER-OLD] Scraping course ${courseId}...`);

        const baseUrl = `${this.START_URL}/courses/${courseId}`;

        // Initialize course data structure
        this.coursesData[courseId] = {
            id: courseId,
            name: `Course ${courseId}`,
            tabs: {}, // Changed from 'sections' to 'tabs' to match scraper-core.js
            scrapedAt: Date.now()
        };

        try {
            // Get course name
            const courseInfo = await this.getCourseInfo(courseId, baseUrl);
            this.coursesData[courseId].name = courseInfo.name;
            console.log(`[SCRAPER-OLD]   Course name: ${courseInfo.name}`);

            if (this.stopRequested) return;

            // Get all navigation tabs (from scraper-core.js getCourseTabs)
            const tabs = await this.getCourseTabs(courseId, baseUrl);
            console.log(`[SCRAPER-OLD]   Found ${tabs.length} tabs in course`);

            // Scrape each tab
            for (const tab of tabs) {
                if (this.stopRequested) break;
                
                console.log(`[SCRAPER-OLD]   📑 Scraping tab: ${tab.name}`);
                
                // Apply syllabus-only mode filter
                if (this.syllabusOnlyMode) {
                    const tabNameLower = tab.name.toLowerCase();
                    const tabUrlLower = tab.url.toLowerCase();
                    if (!tabNameLower.includes('syllabus') && !tabUrlLower.includes('syllabus')) {
                        console.log(`[SCRAPER-OLD]   ⏭️  Skipping non-syllabus tab: ${tab.name}`);
                        continue;
                    }
                }
                
                await this.scrapeTab(courseId, tab);
                await this.sleep(1000);
            }

            // Process queued links from this course (from scraper-core.js processLinkQueue)
            await this.processLinkQueue(courseId);

            // Mark course as completed
            this.coursesData[courseId].fullyCompleted = true;
            this.coursesData[courseId].completedAt = Date.now();

            console.log(`[SCRAPER-OLD]   Completed course ${courseId}`);
            
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
            const info = await this.executeScriptOnPage(baseUrl, () => {
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
            }, 1);
            
            return info || { name: `Course ${courseId}` };
        } catch (e) {
            return { name: `Course ${courseId}` };
        }
    }

    // Get all tabs in a course (from scraper-core.js getCourseTabs, adapted for extension)
    async getCourseTabs(courseId, baseUrl) {
        const tabsData = await this.executeScriptOnPage(baseUrl, () => {
            const tabs = [];
            
            // Find navigation menu (from scraper-core.js)
            const navSelectors = [
                'nav[role="navigation"] a',
                '.course-navigation a',
                '#section-tabs a',
                '[class*="navigation"] a[href*="/courses/"]'
            ];
            
            const tabLinks = new Set();
            
            for (const selector of navSelectors) {
                const links = document.querySelectorAll(selector);
                for (const link of links) {
                    const href = link.href;
                    const text = link.textContent.trim();
                    
                    // Skip if not a Canvas URL
                    try {
                        const urlObj = new URL(href, window.location.origin);
                        if (!urlObj.hostname.includes('canvas.cornell.edu') && 
                            !urlObj.hostname.includes('instructure.com')) {
                            continue;
                        }
                    } catch (e) {
                        continue;
                    }
                    
                    // Skip external services (from utils.js)
                    const externalDomains = [
                        'edstem.org', 'gradescope.com', 'zoom.us', 'piazza.com',
                        'youtube.com', 'youtu.be', 'google.com', 'docs.google.com'
                    ];
                    if (externalDomains.some(domain => href.includes(domain))) {
                        continue;
                    }
                    
                    // Normalize URL (from utils.js normalizeURL)
                    let normalizedURL = href;
                    try {
                        const urlObj = new URL(href);
                        const importantParams = ['module_item_id', 'course_id'];
                        const newParams = new URLSearchParams();
                        for (const param of importantParams) {
                            if (urlObj.searchParams.has(param)) {
                                newParams.set(param, urlObj.searchParams.get(param));
                            }
                        }
                        urlObj.search = newParams.toString();
                        normalizedURL = urlObj.toString();
                    } catch (e) {
                        normalizedURL = href;
                    }
                    
                    tabLinks.add(JSON.stringify({
                        name: text,
                        url: normalizedURL
                    }));
                }
            }
            
            // Convert back to objects
            for (const tabJson of tabLinks) {
                tabs.push(JSON.parse(tabJson));
            }
            
            return tabs;
        }, 1);
        
        return tabsData || [];
    }

    // Scrape a single tab (from scraper-core.js scrapeTab, adapted for extension)
    async scrapeTab(courseId, tab) {
        const tabKey = this.sanitizeFilename(tab.name.toLowerCase().replace(/\s+/g, '_'));
        
        // Navigate to tab using persistent tab
        const tabUrl = tab.url;
        const normalizedUrl = this.normalizeURL(tabUrl);
        
        // Skip if already visited
        if (this.visitedURLs.has(normalizedUrl)) {
            console.log(`[SCRAPER-OLD]   ⏭️  Already visited: ${tab.name}`);
            return;
        }
        
        this.visitedURLs.add(normalizedUrl);
        
        // Scrape the page using new logic
        const pageData = await this.scrapePage(courseId, tabUrl);
        
        if (pageData) {
            this.coursesData[courseId].tabs[tabKey] = pageData;
            
            // Add scraped content to sections for backward compatibility with formatCorpusForGPT
            if (!this.coursesData[courseId].sections) {
                this.coursesData[courseId].sections = {};
            }
            
            // Map tab to section format
            const sectionName = this.mapTabToSection(tab.name);
            if (!this.coursesData[courseId].sections[sectionName]) {
                this.coursesData[courseId].sections[sectionName] = {
                    content: pageData.text || '',
                    title: pageData.title || tab.name,
                    metadata: pageData.metadata || {}
                };
            } else {
                // Append if section already exists
                this.coursesData[courseId].sections[sectionName].content += '\n\n' + (pageData.text || '');
            }
            
            console.log(`[SCRAPER-OLD]   ✅ Scraped ${tab.name} (${(pageData.text || '').length} chars)`);
        }
    }

    // Map tab name to section name for backward compatibility
    mapTabToSection(tabName) {
        const name = tabName.toLowerCase();
        if (name.includes('home') || name === '') return 'home';
        if (name.includes('syllabus')) return 'syllabus';
        if (name.includes('module')) return 'modules';
        if (name.includes('file')) return 'files';
        if (name.includes('assignment')) return 'assignments';
        if (name.includes('announcement') || name.includes('discussion')) return 'announcements';
        if (name.includes('page')) return 'pages';
        return 'other';
    }

    // Scrape a single page (from scraper-core.js scrapePage + extractPageContent, adapted)
    async scrapePage(courseId, url) {
        try {
            // Execute full scraping workflow in a single script injection
            // This combines expand, scroll, PDF detection, and content extraction
            const pageData = await this.executeScriptOnPage(url, async () => {
                // Wait for page load
                await new Promise(resolve => {
                    if (document.readyState === 'complete') {
                        resolve();
                    } else {
                        window.addEventListener('load', resolve);
                    }
                });
                await new Promise(resolve => setTimeout(resolve, 1500));
                
                // Helper: Expand all content (from scraper-core.js expandAllContent)
                const expandAllContent = async () => {
                    // Click "Expand All" buttons
                    const expandAllButtons = document.querySelectorAll(
                        'button[aria-label*="expand all" i], ' +
                        'button[class*="expand-all" i], ' +
                        '.expand-collapse-all'
                    );
                    
                    for (const button of expandAllButtons) {
                        const style = window.getComputedStyle(button);
                        if (style.display !== 'none' && style.visibility !== 'hidden' && button.offsetParent !== null) {
                            button.click();
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    
                    // Expand individual collapsible items
                    const collapsibleSelectors = [
                        '[aria-expanded="false"]',
                        'details:not([open])',
                        '[class*="collapsed"]'
                    ];
                    
                    for (const selector of collapsibleSelectors) {
                        const elements = document.querySelectorAll(selector);
                        for (const element of elements) {
                            const style = window.getComputedStyle(element);
                            if (style.display === 'none' || element.offsetParent === null) continue;
                            
                            if (element.tagName === 'DETAILS') {
                                element.open = true;
                            } else if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') {
                                element.click();
                            }
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 1000));
                };
                
                // Helper: Scroll all containers (from scraper-core.js scrollAllContainers)
                const scrollAllContainers = async () => {
                    function findScrollableElements() {
                        const scrollable = [];
                        const elements = document.querySelectorAll('*');
                        for (const el of elements) {
                            if (el.offsetParent === null) continue;
                            const style = window.getComputedStyle(el);
                            const hasVerticalScroll = el.scrollHeight > el.clientHeight;
                            const isScrollableY = style.overflowY === 'auto' || 
                                                  style.overflowY === 'scroll' ||
                                                  style.overflow === 'auto' ||
                                                  style.overflow === 'scroll';
                            if (hasVerticalScroll && isScrollableY) {
                                scrollable.push({ element: el, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
                            }
                        }
                        scrollable.sort((a, b) => (b.scrollHeight * (b.scrollWidth || 0)) - (a.scrollHeight * (a.scrollWidth || 0)));
                        return scrollable;
                    }
                    
                    async function scrollToBottom(element, options = {}) {
                        const stepSize = options.stepSize || 0.8;
                        const delay = options.delay || 300;
                        const step = Math.floor(element.clientHeight * stepSize);
                        let currentScroll = 0;
                        let scrollMax = element.scrollHeight;
                        
                        while (currentScroll < scrollMax) {
                            element.scrollTop = currentScroll;
                            await new Promise(resolve => setTimeout(resolve, delay));
                            const newScrollMax = element.scrollHeight;
                            if (newScrollMax > scrollMax) scrollMax = newScrollMax;
                            currentScroll += step;
                        }
                        element.scrollTop = scrollMax;
                        await new Promise(resolve => setTimeout(resolve, delay * 2));
                    }
                    
                    const scrollable = findScrollableElements();
                    for (let i = 0; i < scrollable.length; i++) {
                        const item = scrollable[i];
                        if (item.clientHeight < 100) continue;
                        try {
                            await scrollToBottom(item.element, { stepSize: 0.7, delay: 400 });
                        } catch (e) {}
                    }
                    
                    if (document.documentElement.scrollHeight > window.innerHeight) {
                        await scrollToBottom(document.documentElement, { stepSize: 0.8, delay: 300 });
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 1000));
                };
                
                // Helper: Check if PDF (from pdf-extractor.js)
                const isPDFViewerPage = () => {
                    const currentUrl = window.location.href;
                    const title = document.title.toLowerCase();
                    if (currentUrl.includes('.pdf') || currentUrl.includes('/files/') || title.includes('.pdf')) {
                        return true;
                    }
                    const pdfElements = document.querySelectorAll(
                        'iframe[src*="pdf"], embed[type="application/pdf"], object[type="application/pdf"], .pdf-viewer, [class*="PdfViewer"]'
                    );
                    return pdfElements.length > 0;
                };
                
                // Helper: Extract PDF (from pdf-extractor.js)
                const extractPDF = async () => {
                    let text = '';
                    
                    // Scroll internal containers for PDFs
                    const internalContainers = document.querySelectorAll('.Pages, [class*="Pages"], .content, [class*="content"]');
                    for (const container of internalContainers) {
                        let lastScroll = 0;
                        for (let j = 0; j < 12; j++) {
                            container.scrollTop = container.scrollHeight;
                            await new Promise(resolve => setTimeout(resolve, 200));
                            if (container.scrollTop === lastScroll) break;
                            lastScroll = container.scrollTop;
                        }
                        container.scrollTop = 0;
                    }
                    
                    // Try text layers (PDF.js style)
                    const textLayers = document.querySelectorAll('.textLayer, [class*="text-layer"], .TextLayer-container .textLayer, .TextLayer-container');
                    if (textLayers.length > 0) {
                        textLayers.forEach((layer, index) => {
                            const layerText = layer.textContent || layer.innerText;
                            if (layerText && layerText.trim()) {
                                text += `\n--- Page ${index + 1} ---\n${layerText.trim()}\n`;
                            } else {
                                const childText = Array.from(layer.querySelectorAll('span, div'))
                                    .map(el => el.textContent || el.innerText)
                                    .filter(t => t && t.trim())
                                    .join(' ');
                                if (childText && childText.trim()) {
                                    text += `\n--- Page ${index + 1} ---\n${childText.trim()}\n`;
                                }
                            }
                        });
                    }
                    
                    // Try iframe
                    const iframes = document.querySelectorAll('iframe[src*="pdf"], iframe[src*="file_preview"]');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            if (iframeDoc) {
                                const iframeTextLayers = iframeDoc.querySelectorAll('.textLayer, [class*="text-layer"]');
                                iframeTextLayers.forEach((layer) => {
                                    const layerText = layer.textContent || layer.innerText;
                                    if (layerText && layerText.trim()) {
                                        text += '\n' + layerText.trim() + '\n';
                                    }
                                });
                            }
                        } catch (e) {
                            // Cross-origin, skip
                        }
                    }
                    
                    // Fallback: extract visible text
                    if (!text || text.length < 100) {
                        const clone = document.body.cloneNode(true);
                        clone.querySelectorAll('script, style, noscript, nav, header, footer').forEach(el => el.remove());
                        text = clone.textContent || clone.innerText || '';
                        text = text.replace(/\s+/g, ' ').trim();
                    }
                    
                    return {
                        content: text,
                        metadata: {
                            url: window.location.href,
                            title: document.title,
                            filename: document.title.split(':')[0].trim() || 'unknown.pdf'
                        }
                    };
                };
                
                // Helper: Extract page content (from scraper-core.js extractPageContent)
                const extractPageContent = () => {
                    function extractTextWithStructure(element) {
                        if (!element) return '';
                        const clone = element.cloneNode(true);
                        clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
                        clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
                            const level = parseInt(heading.tagName[1]);
                            heading.textContent = '\n' + '#'.repeat(level) + ' ' + heading.textContent.trim() + '\n';
                        });
                        clone.querySelectorAll('li').forEach(li => {
                            li.textContent = '- ' + li.textContent.trim() + '\n';
                        });
                        clone.querySelectorAll('p, div').forEach(p => {
                            p.textContent = p.textContent.trim() + '\n\n';
                        });
                        return clone.textContent.trim();
                    }
                    
                    const mainContentSelectors = [
                        'main', '[role="main"]', '#content', '.content', '#main', '.main-content', 'article'
                    ];
                    
                    let mainContent = null;
                    for (const selector of mainContentSelectors) {
                        mainContent = document.querySelector(selector);
                        if (mainContent) break;
                    }
                    if (!mainContent) mainContent = document.body;
                    
                    const text = extractTextWithStructure(mainContent);
                    
                    // Extract links
                    const links = [];
                    const anchors = document.querySelectorAll('a[href]');
                    for (const anchor of anchors) {
                        try {
                            const href = new URL(anchor.href, window.location.origin).toString();
                            const externalDomains = [
                                'edstem.org', 'gradescope.com', 'zoom.us', 'piazza.com',
                                'youtube.com', 'youtu.be', 'google.com', 'docs.google.com'
                            ];
                            if (externalDomains.some(domain => href.includes(domain))) continue;
                            if (!href.includes('canvas.cornell.edu') && !href.includes('instructure.com')) continue;
                            if (href.startsWith('javascript:')) continue;
                            links.push({ url: href, text: anchor.textContent.trim(), title: anchor.title || '' });
                        } catch (e) {
                            continue;
                        }
                    }
                    
                    const metadata = {};
                    const courseIdMatch = window.location.href.match(/\/courses\/(\d+)/);
                    if (courseIdMatch) metadata.courseId = courseIdMatch[1];
                    
                    return {
                        type: 'page',
                        text: text,
                        title: document.title || 'Untitled',
                        url: window.location.href,
                        links: links,
                        metadata: metadata
                    };
                };
                
                // Main execution flow
                await expandAllContent();
                await scrollAllContainers();
                
                // Check if PDF and extract
                if (isPDFViewerPage()) {
                    const pdfData = await extractPDF();
                    if (pdfData && pdfData.content && pdfData.content.length > 100) {
                        // Extract links too
                        const links = extractPageContent().links || [];
                        return {
                            type: 'pdf',
                            text: pdfData.content,
                            title: pdfData.metadata.filename || pdfData.metadata.title || 'PDF',
                            metadata: pdfData.metadata,
                            url: window.location.href,
                            links: links
                        };
                    }
                }
                
                // Extract regular page content
                return extractPageContent();
            }, 1, this.currentCourseContext);
            
            if (pageData) {
                // Add links to queue
                if (pageData.links && pageData.links.length > 0) {
                    this.addLinksToQueue(pageData.links, courseId);
                }
                
                return {
                    type: pageData.type || 'page',
                    text: pageData.text || '',
                    title: pageData.title || 'Untitled',
                    url: pageData.url || url,
                    metadata: pageData.metadata || {}
                };
            }
            
            return null;
            
        } catch (error) {
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            console.error(`[SCRAPER-OLD]   ✗ Error scraping page ${url}: ${error.message}`);
            return null;
        }
    }
    
    // Add links to queue for processing
    addLinksToQueue(links, courseId) {
        if (!links || !Array.isArray(links)) return;
        
        for (const link of links) {
            if (!link.url) continue;
            
            const normalizedUrl = this.normalizeURL(link.url);
            if (!this.visitedURLs.has(normalizedUrl) && 
                !this.linkQueue.some(item => item.url === normalizedUrl)) {
                this.linkQueue.push({
                    url: normalizedUrl,
                    courseId: courseId,
                    context: {
                        text: link.text || '',
                        title: link.title || '',
                        type: this.determineContentType(link.url)
                    }
                });
            }
        }
    }
    
    determineContentType(url) {
        if (!url) return 'unknown';
        if (url.includes('/files/')) return 'file';
        if (url.includes('/assignments/')) return 'assignment';
        if (url.includes('/pages/')) return 'page';
        if (url.includes('/quizzes/')) return 'quiz';
        if (url.includes('/discussion_topics/')) return 'discussion';
        if (url.includes('/modules/')) return 'module';
        if (url.includes('.pdf')) return 'pdf';
        return 'link';
    }

    // Process queued links (from scraper-core.js processLinkQueue, adapted)
    async processLinkQueue(courseId) {
        // Filter links for this course
        const courseLinks = this.linkQueue.filter(item => item.courseId === courseId);
        
        // Remove processed links from queue
        this.linkQueue = this.linkQueue.filter(item => item.courseId !== courseId);
        
        if (courseLinks.length === 0) return;
        
        console.log(`[SCRAPER-OLD]   🔗 Processing ${courseLinks.length} queued links...`);
        
        let processed = 0;
        const maxLinks = 100;
        
        for (const linkItem of courseLinks) {
            if (this.stopRequested) break;
            if (processed >= maxLinks) {
                console.log(`[SCRAPER-OLD]   ⚠️  Reached max link limit (${maxLinks})`);
                break;
            }
            
            if (this.visitedURLs.has(linkItem.url)) continue;
            
            // Apply syllabus-only mode filter
            if (this.syllabusOnlyMode) {
                const urlLower = linkItem.url.toLowerCase();
                const contextLower = JSON.stringify(linkItem.context || {}).toLowerCase();
                if (!urlLower.includes('syllabus') && !contextLower.includes('syllabus')) {
                    continue;
                }
            }
            
            console.log(`[SCRAPER-OLD]   📎 Following link: ${linkItem.url}`);
            
            try {
                const pageData = await this.scrapePage(courseId, linkItem.url);
                if (pageData) {
                    // Store as a page/file in the course data
                    const key = `page_${Date.now()}_${processed}`;
                    this.coursesData[courseId].tabs[key] = {
                        ...pageData,
                        context: linkItem.context
                    };
                    
                    // Also add to sections
                    const sectionName = this.mapTabToSection(linkItem.context?.type || 'other');
                    if (!this.coursesData[courseId].sections[sectionName]) {
                        this.coursesData[courseId].sections[sectionName] = [];
                    }
                    if (Array.isArray(this.coursesData[courseId].sections[sectionName])) {
                        this.coursesData[courseId].sections[sectionName].push({
                            name: linkItem.context?.text || 'Link',
                            content: pageData.text || '',
                            url: linkItem.url
                        });
                    }
                }
                processed++;
            } catch (e) {
                console.error(`[SCRAPER-OLD]   ❌ Failed to scrape link: ${e.message}`);
            }
            
            await this.sleep(800);
        }
        
        console.log(`[SCRAPER-OLD]   ✅ Processed ${processed} links`);
    }

    // ===== UTILITY FUNCTIONS (FROM utils.js, adapted for extension) =====
    
    normalizeURL(url) {
        try {
            const urlObj = new URL(url);
            const importantParams = ['module_item_id', 'course_id'];
            const newParams = new URLSearchParams();
            for (const param of importantParams) {
                if (urlObj.searchParams.has(param)) {
                    newParams.set(param, urlObj.searchParams.get(param));
                }
            }
            urlObj.search = newParams.toString();
            return urlObj.toString();
        } catch (e) {
            return url;
        }
    }
    
    sanitizeFilename(filename) {
        return filename
            .replace(/[^a-z0-9_\-\.]/gi, '_')
            .replace(/_{2,}/g, '_')
            .substring(0, 200);
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ===== PAGE SCRAPING HELPERS (from scraper-core.js, to be injected) =====
    
    // These functions will be injected into pages via executeScriptOnPage
    // They need to be defined as strings to be executed in page context
    
    getExpandAllContentScript() {
        return function() {
            // Click "Expand All" buttons
            const expandAllButtons = document.querySelectorAll(
                'button[aria-label*="expand all" i], ' +
                'button[class*="expand-all" i], ' +
                '.expand-collapse-all, ' +
                'button:contains("Expand All")'
            );
            
            for (const button of expandAllButtons) {
                const style = window.getComputedStyle(button);
                if (style.display !== 'none' && 
                    style.visibility !== 'hidden' && 
                    button.offsetParent !== null) {
                    button.click();
                    // Wait a bit
                    const wait = Date.now();
                    while (Date.now() - wait < 500) {}
                }
            }
            
            // Expand individual collapsible items
            const collapsibleSelectors = [
                '[aria-expanded="false"]',
                'details:not([open])',
                '[class*="collapsed"]'
            ];
            
            for (const selector of collapsibleSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const element of elements) {
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || element.offsetParent === null) continue;
                    
                    if (element.tagName === 'DETAILS') {
                        element.open = true;
                    } else if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') {
                        element.click();
                    }
                    
                    const wait = Date.now();
                    while (Date.now() - wait < 200) {}
                }
            }
            
            // Wait for expansions
            return new Promise(resolve => {
                setTimeout(resolve, 1000);
            });
        };
    }
    
    getScrollAllContainersScript() {
        return async function() {
            // Find scrollable elements (from utils.js findScrollableElements)
            function findScrollableElements() {
                const scrollable = [];
                const elements = document.querySelectorAll('*');
                
                for (const el of elements) {
                    if (el.offsetParent === null) continue;
                    
                    const style = window.getComputedStyle(el);
                    const hasVerticalScroll = el.scrollHeight > el.clientHeight;
                    const isScrollableY = style.overflowY === 'auto' || 
                                          style.overflowY === 'scroll' ||
                                          style.overflow === 'auto' ||
                                          style.overflow === 'scroll';
                    
                    if (hasVerticalScroll && isScrollableY) {
                        scrollable.push({
                            element: el,
                            scrollHeight: el.scrollHeight,
                            clientHeight: el.clientHeight
                        });
                    }
                }
                
                scrollable.sort((a, b) => {
                    const aSize = a.scrollHeight * (a.scrollWidth || 0);
                    const bSize = b.scrollHeight * (b.scrollWidth || 0);
                    return bSize - aSize;
                });
                
                return scrollable;
            }
            
            // Scroll to bottom (from utils.js scrollToBottom)
            async function scrollToBottom(element, options = {}) {
                const stepSize = options.stepSize || 0.8;
                const delay = options.delay || 300;
                
                const step = Math.floor(element.clientHeight * stepSize);
                let currentScroll = 0;
                let scrollMax = element.scrollHeight;
                
                while (currentScroll < scrollMax) {
                    element.scrollTop = currentScroll;
                    await new Promise(resolve => setTimeout(resolve, delay));
                    
                    const newScrollMax = element.scrollHeight;
                    if (newScrollMax > scrollMax) {
                        scrollMax = newScrollMax;
                    }
                    
                    currentScroll += step;
                }
                
                element.scrollTop = scrollMax;
                await new Promise(resolve => setTimeout(resolve, delay * 2));
            }
            
            const scrollable = findScrollableElements();
            
            for (let i = 0; i < scrollable.length; i++) {
                const item = scrollable[i];
                if (item.clientHeight < 100) continue; // Skip small containers
                
                try {
                    await scrollToBottom(item.element, {
                        stepSize: 0.7,
                        delay: 400
                    });
                } catch (e) {
                    // Continue on error
                }
            }
            
            // Scroll main window
            if (document.documentElement.scrollHeight > window.innerHeight) {
                await scrollToBottom(document.documentElement, {
                    stepSize: 0.8,
                    delay: 300
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        };
    }
    
    getIsPDFViewerPageScript() {
        return function() {
            const url = window.location.href;
            const title = document.title.toLowerCase();
            
            if (url.includes('.pdf') || url.includes('/files/')) {
                return true;
            }
            
            if (title.includes('.pdf')) {
                return true;
            }
            
            const pdfElements = document.querySelectorAll(
                'iframe[src*="pdf"], ' +
                'embed[type="application/pdf"], ' +
                'object[type="application/pdf"], ' +
                '.pdf-viewer, ' +
                '[class*="PdfViewer"]'
            );
            
            return pdfElements.length > 0;
        };
    }
    
    getExtractPDFScript() {
        return async function() {
            // Extract from Canvas viewer (from pdf-extractor.js)
            const viewerSelectors = [
                'iframe[src*="pdf"]',
                'iframe[src*="file_preview"]',
                '.pdf-viewer',
                '[class*="PdfViewer"]',
                'embed[type="application/pdf"]'
            ];
            
            let viewer = null;
            for (const selector of viewerSelectors) {
                viewer = document.querySelector(selector);
                if (viewer) break;
            }
            
            let text = '';
            
            // Try text layers (PDF.js style)
            const textLayers = document.querySelectorAll('.textLayer, [class*="text-layer"], .TextLayer-container .textLayer');
            if (textLayers.length > 0) {
                textLayers.forEach((layer, index) => {
                    const layerText = layer.textContent || layer.innerText;
                    if (layerText.trim()) {
                        text += `\n--- Page ${index + 1} ---\n${layerText.trim()}\n`;
                    } else {
                        // Try child elements
                        const childText = Array.from(layer.querySelectorAll('span, div'))
                            .map(el => el.textContent || el.innerText)
                            .filter(t => t.trim())
                            .join(' ');
                        if (childText.trim()) {
                            text += `\n--- Page ${index + 1} ---\n${childText.trim()}\n`;
                        }
                    }
                });
            }
            
            // Scroll internal containers for PDFs
            if (viewer && viewer.tagName === 'IFRAME') {
                try {
                    const iframeDoc = viewer.contentDocument || viewer.contentWindow.document;
                    if (iframeDoc) {
                        // Scroll iframe content
                        const scrollable = iframeDoc.querySelectorAll('.Pages, [class*="Pages"], .content');
                        for (const container of scrollable) {
                            let lastScroll = 0;
                            for (let j = 0; j < 12; j++) {
                                container.scrollTop = container.scrollHeight;
                                await new Promise(resolve => setTimeout(resolve, 200));
                                if (container.scrollTop === lastScroll) break;
                                lastScroll = container.scrollTop;
                            }
                            container.scrollTop = 0;
                        }
                        
                        // Extract from iframe
                        const iframeTextLayers = iframeDoc.querySelectorAll('.textLayer, [class*="text-layer"]');
                        iframeTextLayers.forEach((layer) => {
                            const layerText = layer.textContent || layer.innerText;
                            if (layerText.trim()) {
                                text += '\n' + layerText.trim() + '\n';
                            }
                        });
                    }
                } catch (e) {
                    // Cross-origin, skip
                }
            }
            
            // Fallback: extract visible text
            if (!text || text.length < 100) {
                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, nav, header, footer').forEach(el => el.remove());
                text = clone.textContent || clone.innerText || '';
                text = text.replace(/\s+/g, ' ').trim();
            }
            
            return {
                content: text,
                metadata: {
                    url: window.location.href,
                    title: document.title,
                    filename: document.title.split(':')[0].trim() || 'unknown.pdf'
                }
            };
        };
    }
    
    getExtractLinksScript() {
        return function() {
            const links = [];
            const anchors = document.querySelectorAll('a[href]');
            
            for (const anchor of anchors) {
                try {
                    const href = new URL(anchor.href, window.location.origin).toString();
                    
                    const externalDomains = [
                        'edstem.org', 'gradescope.com', 'zoom.us', 'piazza.com',
                        'youtube.com', 'youtu.be', 'google.com', 'docs.google.com'
                    ];
                    if (externalDomains.some(domain => href.includes(domain))) {
                        continue;
                    }
                    
                    if (!href.includes('canvas.cornell.edu') && !href.includes('instructure.com')) {
                        continue;
                    }
                    
                    if (href.startsWith('javascript:')) {
                        continue;
                    }
                    
                    links.push({
                        url: href,
                        text: anchor.textContent.trim(),
                        title: anchor.title || ''
                    });
                } catch (e) {
                    continue;
                }
            }
            
            return links;
        };
    }
    
    getExtractPageContentScript() {
        return function() {
            const url = window.location.href;
            // Extract text with structure (from utils.js extractTextWithStructure)
            function extractTextWithStructure(element) {
                if (!element) return '';
                
                const clone = element.cloneNode(true);
                clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
                
                // Convert headings
                clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
                    const level = parseInt(heading.tagName[1]);
                    heading.textContent = '\n' + '#'.repeat(level) + ' ' + heading.textContent.trim() + '\n';
                });
                
                // Convert lists
                clone.querySelectorAll('li').forEach(li => {
                    li.textContent = '- ' + li.textContent.trim() + '\n';
                });
                
                // Add line breaks for paragraphs
                clone.querySelectorAll('p, div').forEach(p => {
                    p.textContent = p.textContent.trim() + '\n\n';
                });
                
                return clone.textContent.trim();
            }
            
            // Get main content area (from scraper-core.js extractPageContent)
            const mainContentSelectors = [
                'main',
                '[role="main"]',
                '#content',
                '.content',
                '#main',
                '.main-content',
                'article'
            ];
            
            let mainContent = null;
            for (const selector of mainContentSelectors) {
                mainContent = document.querySelector(selector);
                if (mainContent) break;
            }
            
            if (!mainContent) {
                mainContent = document.body;
            }
            
            const text = extractTextWithStructure(mainContent);
            
            // Extract links (from utils.js getAllLinks)
            function getAllLinks() {
                const links = [];
                const anchors = document.querySelectorAll('a[href]');
                
                for (const anchor of anchors) {
                    try {
                        const href = new URL(anchor.href, window.location.origin).toString();
                        
                        // Skip external
                        const externalDomains = [
                            'edstem.org', 'gradescope.com', 'zoom.us', 'piazza.com',
                            'youtube.com', 'youtu.be', 'google.com', 'docs.google.com'
                        ];
                        if (externalDomains.some(domain => href.includes(domain))) {
                            continue;
                        }
                        
                        if (!href.includes('canvas.cornell.edu') && !href.includes('instructure.com')) {
                            continue;
                        }
                        
                        if (href.startsWith('javascript:')) {
                            continue;
                        }
                        
                        links.push({
                            url: href,
                            text: anchor.textContent.trim(),
                            title: anchor.title || ''
                        });
                    } catch (e) {
                        continue;
                    }
                }
                
                return links;
            }
            
            // Extract links (simplified version)
            const links = [];
            const anchors = document.querySelectorAll('a[href]');
            for (const anchor of anchors) {
                try {
                    const href = new URL(anchor.href, window.location.origin).toString();
                    const externalDomains = [
                        'edstem.org', 'gradescope.com', 'zoom.us', 'piazza.com',
                        'youtube.com', 'youtu.be', 'google.com', 'docs.google.com'
                    ];
                    if (externalDomains.some(domain => href.includes(domain))) continue;
                    if (!href.includes('canvas.cornell.edu') && !href.includes('instructure.com')) continue;
                    if (href.startsWith('javascript:')) continue;
                    links.push({
                        url: href,
                        text: anchor.textContent.trim(),
                        title: anchor.title || ''
                    });
                } catch (e) {
                    continue;
                }
            }
            
            // Extract metadata
            const metadata = {};
            const courseIdMatch = url.match(/\/courses\/(\d+)/);
            if (courseIdMatch) {
                metadata.courseId = courseIdMatch[1];
            }
            
            return {
                type: 'page',
                text: text,
                title: document.title || 'Untitled',
                url: url,
                links: links,
                metadata: metadata
            };
        };
    }

    // ===== MODIFIED executeScriptOnPage TO USE NEW LOGIC =====
    
    async executeScriptOnPage(url, scriptFunc, retries = 0, context = null) {
        const executeContext = context || this.currentCourseContext;
        const courseId = executeContext?.courseId || url.match(/\/courses\/(\d+)/)?.[1];
        
        // Use persistent course tab (like Python's single driver)
        if (courseId) {
            return await this._executeScriptOnPersistentTab(courseId, url, scriptFunc, executeContext);
        } else {
            return await this._executeScriptOnTemporaryTab(url, scriptFunc, executeContext);
        }
    }
    
    async _executeScriptOnPersistentTab(courseId, url, scriptFunc, context) {
        let tabId;
        try {
            tabId = await this.navigateCourseTab(courseId, url);
        } catch (error) {
            console.log(`[SCRAPER-OLD] Failed to navigate persistent tab, using temporary tab: ${error.message}`);
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
                            // Execute the script function
                            const result = await chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                func: scriptFunc
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
                                func: scriptFunc
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
                let resolved = false;

                const listener = (updatedTabId, changeInfo) => {
                    if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
                        chrome.tabs.onUpdated.removeListener(listener);
                        
                        setTimeout(async () => {
                            if (resolved) return;

                            try {
                                const result = await chrome.scripting.executeScript({
                                    target: { tabId: tabId },
                                    func: scriptFunc
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

    // Helper methods for persistent tabs (from previous version)
    async getOrCreateCourseTab(courseId) {
        if (this.courseTabs.has(courseId)) {
            const existingTabId = this.courseTabs.get(courseId);
            try {
                const tab = await new Promise((resolve) => {
                    chrome.tabs.get(existingTabId, resolve);
                });
                if (tab && !chrome.runtime.lastError) {
                    return existingTabId;
                }
            } catch (e) {
                this.courseTabs.delete(courseId);
            }
        }
        
        const createTabOptions = { 
            url: `${this.START_URL}/courses/${courseId}`,
            active: false 
        };
        if (this.targetWindowId) {
            createTabOptions.windowId = this.targetWindowId;
        }
        
        return new Promise((resolve, reject) => {
            chrome.tabs.create(createTabOptions, (tab) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to create tab: ${chrome.runtime.lastError.message}`));
                    return;
                }
                this.courseTabs.set(courseId, tab.id);
                resolve(tab.id);
            });
        });
    }
    
    async navigateCourseTab(courseId, url) {
        const tabId = await this.getOrCreateCourseTab(courseId);
        
        return new Promise((resolve, reject) => {
            chrome.tabs.update(tabId, { url: url }, (tab) => {
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message;
                    if (errorMsg.includes('No tab with id')) {
                        this.courseTabs.delete(courseId);
                        this.navigateCourseTab(courseId, url).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`Failed to navigate tab: ${errorMsg}`));
                    }
                    return;
                }
                resolve(tabId);
            });
        });
    }
    
    async closeAllScrapingTabs() {
        for (const [courseId, tabId] of this.courseTabs.entries()) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {}
        }
        this.courseTabs.clear();
        
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
    }
    
    async ensureScrapingWindow() {
        if (this.targetWindowId) {
            try {
                const window = await new Promise((resolve) => {
                    chrome.windows.get(this.targetWindowId, resolve);
                });
                if (window && !chrome.runtime.lastError) {
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
            if (course.tabs) {
                for (const tabKey in course.tabs) {
                    const tab = course.tabs[tabKey];
                    if (tab.text) {
                        tab.text = processContent(tab.text);
                    }
                }
            }
            if (course.sections) {
                for (const sectionName in course.sections) {
                    const section = course.sections[sectionName];
                    if (section.content) {
                        section.content = processContent(section.content);
                    } else if (Array.isArray(section)) {
                        for (const item of section) {
                            if (item.content) {
                                item.content = processContent(item.content);
                            }
                        }
                    }
                }
            }
        }
    }

    formatCorpusForGPT() {
        let corpus = '';
        for (const courseId in this.coursesData) {
            const course = this.coursesData[courseId];
            corpus += `\n\n=== COURSE: ${course.name || courseId} ===\n\n`;
            
            // Use sections if available (backward compatible)
            if (course.sections) {
                for (const sectionName in course.sections) {
                    const section = course.sections[sectionName];
                    if (section.content) {
                        corpus += `--- ${sectionName} ---\n${section.content}\n\n`;
                    } else if (Array.isArray(section)) {
                        for (const item of section) {
                            if (item.content) {
                                corpus += `--- ${sectionName}: ${item.name || 'Item'} ---\n${item.content}\n\n`;
                            }
                        }
                    }
                }
            }
            
            // Also use tabs (new format)
            if (course.tabs) {
                for (const tabKey in course.tabs) {
                    const tab = course.tabs[tabKey];
                    if (tab.text) {
                        corpus += `--- ${tab.title || tabKey} ---\n${tab.text}\n\n`;
                    }
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
4. ALL readings with summaries
5. ALL lecture information
6. ALL notes and supplementary materials
7. ALL dates for everything
8. Grade information
9. Course policies

OUTPUT FORMAT: Output clean, readable text organized by course.

OUTPUT LENGTH: Target approximately 480,000 characters (120,000 tokens) per batch.

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
        this.visitedURLs.clear();
        this.linkQueue = [];
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

