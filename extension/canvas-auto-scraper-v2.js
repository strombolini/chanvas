// Canvas Auto-Scraper v2 - Based on canvas_scraper.py logic
// Matches the flow of run_canvas_scrape_job and get_fall_2025_course_ids

class CanvasAutoScraper {
    constructor() {
        this.scrapingInProgress = false;
        this.coursesData = {};
        this.targetWindowId = null; // Window to create tabs in
        
        // Courses to skip (login pages, help pages, or invalid courses)
        this.excludedCourseIds = [
            '14918', // Career Development Toolkit - join course page
            '14901', // Login/help page
            '45845', // Login/help page
            '40187', // Login/help page
            '46043'  // Login/help page
        ];
    }

    // Main entry point - matches run_canvas_scrape_job
    async startAutoScrape(progressCallback, windowId = null) {
        if (this.scrapingInProgress) {
            console.log('Scraping already in progress');
            return;
        }

        console.log('[SCRAPER] Starting automated Canvas scrape...');
        this.scrapingInProgress = true;
        this.coursesData = {};
        this.progressCallback = progressCallback;
        this.targetWindowId = windowId; // Store the window ID to use for tabs

        try {
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

            this.sendProgress(`Found ${courseIds.length} courses. Starting scrape...`);

            // Step 2: Scrape each course (like run_course_crawl)
            for (let i = 0; i < courseIds.length; i++) {
                const courseId = courseIds[i];
                this.sendProgress(`Scraping course ${i + 1}/${courseIds.length}...`);
                await this.scrapeCourse(courseId);
            }

            // Step 3: Save all data
            this.sendProgress('Saving data...');
            await this.saveScrapedData();

            // Step 3.5: Remove HTML elements from corpus before indexing
            this.sendProgress('Cleaning HTML from scraped data...');
            this.removeHtmlFromCorpus(this.coursesData);

            // Step 4: Index data for RAG
            this.sendProgress('Indexing data for semantic search...');
            try {
                const rag = new ExtensionRAG();
                await rag.indexScrapedData(this.coursesData);
                this.sendProgress('✓ Data indexed for RAG');
            } catch (error) {
                console.error('[SCRAPER] Failed to index data:', error);
                this.sendProgress('⚠ Indexing failed, but data saved locally');
            }

            console.log('[SCRAPER] Automated scraping complete!');
            this.sendProgress('✓ Scraping complete!');
            this.scrapingInProgress = false;

        } catch (error) {
            console.error('[SCRAPER] Error during auto-scrape:', error);
            this.scrapingInProgress = false;
            throw error;
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

    // Normalize and validate a link for crawling (matches normalize_link from Python)
    normalizeLink(href, courseId) {
        if (!href || typeof href !== 'string') return '';
        href = href.trim();
        if (!href) return '';

        try {
            // Convert relative to absolute URL
            const base = 'https://canvas.cornell.edu';
            const fullUrl = href.startsWith('http') ? href : new URL(href, base + '/').href;
            const url = new URL(fullUrl);

            // Must be Canvas domain
            if (!url.hostname.includes('canvas.cornell.edu')) return '';

            // Must be in course or files
            const path = url.pathname;
            const inCourse = path.startsWith(`/courses/${courseId}`) || path.includes(`/courses/${courseId}/`);
            const isFile = path.includes('/files/');
            if (!inCourse && !isFile) return '';

            // Exclude certain paths
            const badPaths = ['/login', '/conversations', '/calendar', '/profile', '/settings/profile', '/settings/notifications'];
            if (badPaths.some(bad => path.includes(bad))) return '';

            // Remove fragment
            url.hash = '';
            return url.href;
        } catch (e) {
            return '';
        }
    }

    // Collect links from a page (matches collect_in_course_links)
    async collectInCourseLinks(url, courseId) {
        try {
            const links = await this.executeScriptOnPage(url, () => {
                // Try to expand sections first to reveal hidden links
                try {
                    const expandBtn = document.querySelector('#expand_collapse_all, [data-expand="false"], [aria-expanded="false"]');
                    if (expandBtn) {
                        expandBtn.click();
                        // Brief wait for expansion
                        const startTime = Date.now();
                        while (Date.now() - startTime < 1000) {
                            // Wait for expansion
                        }
                    }
                } catch (e) {
                    // Ignore
                }

                const anchors = Array.from(document.querySelectorAll('a[href]'));
                return anchors.map(a => a.href);
            });

            const normalizedLinks = new Set();
            for (const href of links) {
                const norm = this.normalizeLink(href, courseId);
                if (norm) {
                    normalizedLinks.add(norm);
                }
            }
            return Array.from(normalizedLinks);
        } catch (error) {
            console.error(`[SCRAPER]   Failed to collect links from ${url}:`, error.message);
            return [];
        }
    }

    // Check if a link is a file (PDF, DOCX, etc.)
    isFileLink(url) {
        if (!url) return false;
        const filePatterns = [
            '/files/',
            '/download',
            '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.rtf'
        ];
        return filePatterns.some(pattern => url.toLowerCase().includes(pattern));
    }

    // Attempt to extract text from a PDF that opens in browser
    async extractPdfText(url) {
        try {
            // Navigate to PDF and try to extract text
            const pdfData = await this.executeScriptOnPage(url, () => {
                // Try to find PDF viewer and extract text
                // Canvas PDFs often render in an iframe or embed
                const iframes = document.querySelectorAll('iframe, embed');
                for (const iframe of iframes) {
                    try {
                        if (iframe.contentDocument && iframe.contentDocument.body) {
                            return iframe.contentDocument.body.innerText || '';
                        }
                    } catch (e) {
                        // Cross-origin, can't access
                    }
                }
                
                // Fallback: try to extract from page body
                return document.body.innerText || document.body.textContent || '';
            }, 1); // Only retry once for PDFs

            return pdfData || '';
        } catch (error) {
            console.warn(`[SCRAPER]   Could not extract PDF text from ${url}:`, error.message);
            return '';
        }
    }

    // Expand all collapsible sections (matches try_expand_all)
    async expandAllSections(url) {
        try {
            await this.executeScriptOnPage(url, () => {
                // Try to find and click expand all button
                const expandBtn = document.querySelector('#expand_collapse_all, [data-expand="false"], [aria-expanded="false"]');
                if (expandBtn) {
                    expandBtn.click();
                    // Wait a bit for expansion
                    return new Promise(resolve => setTimeout(resolve, 1000));
                }
            });
        } catch (error) {
            // Ignore errors - expansion is optional
        }
    }

    // Scroll page to bottom to load lazy content (matches scroll_to_bottom)
    async scrollToBottom(url) {
        try {
            await this.executeScriptOnPage(url, () => {
                return new Promise((resolve) => {
                    let lastHeight = document.body.scrollHeight;
                    let steps = 0;
                    const maxSteps = 12;
                    const scroll = () => {
                        window.scrollTo(0, document.body.scrollHeight);
                        setTimeout(() => {
                            const newHeight = document.body.scrollHeight;
                            steps++;
                            if (newHeight === lastHeight || steps >= maxSteps) {
                                resolve();
                            } else {
                                lastHeight = newHeight;
                                scroll();
                            }
                        }, 300);
                    };
                    scroll();
                });
            });
        } catch (error) {
            // Ignore scroll errors
        }
    }

    // Deep crawl a course using BFS (matches crawl_course)
    async deepCrawlCourse(courseId, baseUrl, courseName) {
        const MAX_LINKS_PER_COURSE = 250;
        const MIN_TEXT_LEN = 80;
        const visitedPages = new Set();
        const visitedFiles = new Set();
        const queue = [];

        // Seed URLs
        const seeds = [
            baseUrl,
            `${baseUrl}/assignments`,
            `${baseUrl}/modules`,
            `${baseUrl}/assignments/syllabus`,
            `${baseUrl}/grades`,
            `${baseUrl}/announcements`
        ];

        queue.push(...seeds);

        let pageCount = 0;
        let fileCount = 0;

        // First, quick harvest files from modules
        try {
            await this.sleep(1000);
            const moduleLinks = await this.collectInCourseLinks(`${baseUrl}/modules`, courseId);
            for (const link of moduleLinks) {
                if (this.isFileLink(link)) {
                    const fileHash = link;
                    if (!visitedFiles.has(fileHash)) {
                        visitedFiles.add(fileHash);
                        fileCount++;
                        try {
                            let fileContent = '';
                            if (link.toLowerCase().endsWith('.pdf') || link.includes('/files/')) {
                                fileContent = await this.extractPdfText(link);
                            }
                            
                            if (fileContent.length >= MIN_TEXT_LEN) {
                                const fileName = link.split('/').pop() || 'file';
                                const pageKey = `file_${fileCount}_${fileName.substring(0, 30)}`;
                                this.coursesData[courseId].pages[pageKey] = {
                                    url: link,
                                    content: fileContent,
                                    textLength: fileContent.length,
                                    title: fileName,
                                    type: 'file'
                                };
                                console.log(`[SCRAPER]   ✓ File: ${fileName} (${fileContent.length} chars)`);
                            }
                        } catch (error) {
                            console.warn(`[SCRAPER]   ✗ Failed to extract file ${link}:`, error.message);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn(`[SCRAPER]   Failed to harvest files from modules:`, error.message);
        }

        // BFS crawl pages
        while (queue.length > 0 && visitedPages.size < MAX_LINKS_PER_COURSE) {
            const url = queue.shift();
            
            // Skip if already visited
            if (visitedPages.has(url)) continue;
            visitedPages.add(url);
            pageCount++;

            try {
                // Small delay before scraping
                await this.sleep(600);

                // Get page content (with expansion and scrolling)
                const pageData = await this.executeScriptOnPage(url, () => {
                    // Expand all sections first
                    try {
                        const expandBtn = document.querySelector('#expand_collapse_all, [data-expand="false"], [aria-expanded="false"]');
                        if (expandBtn) {
                            expandBtn.click();
                            // Wait for expansion
                            const startTime = Date.now();
                            while (Date.now() - startTime < 2000) {
                                // Busy wait for expansion
                            }
                        }
                    } catch (e) {
                        // Ignore
                    }

                    // Scroll to bottom to load lazy content
                    let lastHeight = document.body.scrollHeight;
                    for (let i = 0; i < 12; i++) {
                        window.scrollTo(0, document.body.scrollHeight);
                        // Wait for content to load
                        const startTime = Date.now();
                        while (Date.now() - startTime < 300) {
                            // Busy wait
                        }
                        const newHeight = document.body.scrollHeight;
                        if (newHeight === lastHeight) break;
                        lastHeight = newHeight;
                    }

                    return {
                        text: document.body.innerText || document.body.textContent,
                        html: document.body.innerHTML.substring(0, 50000),
                        title: document.title
                    };
                });

                if (pageData && pageData.text && pageData.text.length >= MIN_TEXT_LEN) {
                    // Generate page key from URL
                    const urlPath = new URL(url).pathname;
                    const pathParts = urlPath.split('/').filter(p => p);
                    let pageKey = pathParts[pathParts.length - 1] || 'page';
                    if (!pageKey || pageKey === courseId) {
                        pageKey = pathParts[pathParts.length - 2] || 'index';
                    }
                    // Make unique if duplicate
                    let uniqueKey = pageKey;
                    let counter = 1;
                    while (this.coursesData[courseId].pages[uniqueKey]) {
                        uniqueKey = `${pageKey}_${counter}`;
                        counter++;
                    }

                    this.coursesData[courseId].pages[uniqueKey] = {
                        url: url,
                        content: pageData.text.substring(0, 50000), // Cap at MAX_PAGE_CHARS
                        textLength: pageData.text.length,
                        title: pageData.title || '',
                        type: 'page'
                    };
                    console.log(`[SCRAPER]   ✓ Page ${pageCount}: ${pageKey} (${pageData.text.length} chars)`);
                }

                // Discover new links
                const discoveredLinks = await this.collectInCourseLinks(url, courseId);
                for (const link of discoveredLinks) {
                    if (this.isFileLink(link)) {
                        // Handle file
                        const fileHash = link;
                        if (!visitedFiles.has(fileHash) && visitedFiles.size < MAX_LINKS_PER_COURSE) {
                            visitedFiles.add(fileHash);
                            fileCount++;
                            try {
                                let fileContent = '';
                                if (link.toLowerCase().endsWith('.pdf') || link.includes('/files/')) {
                                    fileContent = await this.extractPdfText(link);
                                }
                                
                                if (fileContent.length >= MIN_TEXT_LEN) {
                                    const fileName = link.split('/').pop() || 'file';
                                    const fileKey = `file_${fileCount}_${fileName.substring(0, 30)}`;
                                    this.coursesData[courseId].pages[fileKey] = {
                                        url: link,
                                        content: fileContent,
                                        textLength: fileContent.length,
                                        title: fileName,
                                        type: 'file'
                                    };
                                    console.log(`[SCRAPER]   ✓ File: ${fileName} (${fileContent.length} chars)`);
                                }
                            } catch (error) {
                                console.warn(`[SCRAPER]   ✗ Failed to extract file ${link}:`, error.message);
                            }
                        }
                    } else {
                        // Add page to queue
                        if (!visitedPages.has(link) && queue.length + visitedPages.size < MAX_LINKS_PER_COURSE) {
                            queue.push(link);
                        }
                    }
                }

            } catch (error) {
                console.error(`[SCRAPER]   ✗ Failed to crawl ${url}:`, error.message);
            }

            // Small delay between pages
            await this.sleep(300);
        }

        console.log(`[SCRAPER]   Deep crawl complete: ${visitedPages.size} pages, ${visitedFiles.size} files`);
    }

    // Scrape a single course - matches run_course_crawl + crawl_course logic
    async scrapeCourse(courseId) {
        // Safety check: skip excluded courses
        if (this.excludedCourseIds.includes(courseId)) {
            console.log(`[SCRAPER] Skipping excluded course ${courseId}`);
            return;
        }

        console.log(`[SCRAPER] Scraping course ${courseId}...`);

        const baseUrl = `https://canvas.cornell.edu/courses/${courseId}`;

        // Get course name from home page first
        const homePage = await this.executeScriptOnPage(baseUrl, () => {
            return {
                text: document.body.innerText,
                html: document.body.innerHTML,
                title: document.title
            };
        });

        const courseName = this.extractCourseName(homePage, courseId);
        console.log(`[SCRAPER]   Course name: ${courseName}`);

        // Initialize course data structure
        this.coursesData[courseId] = {
            id: courseId,
            name: courseName,
            pages: {},
            scrapedAt: Date.now()
        };

        // Use deep crawl instead of just seed pages
        await this.deepCrawlCourse(courseId, baseUrl, courseName);

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

    // Execute script on a specific page
    async executeScriptOnPage(url, scriptFunc, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await this._executeScriptOnPageAttempt(url, scriptFunc, attempt);
            } catch (error) {
                // If it's the last attempt, throw the error
                if (attempt === retries) {
                    throw error;
                }
                // Wait before retrying (exponential backoff)
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                console.log(`[SCRAPER]     Retrying in ${delay}ms... (attempt ${attempt + 1}/${retries + 1})`);
                await this.sleep(delay);
            }
        }
    }

    // Single attempt to execute script on a page
    async _executeScriptOnPageAttempt(url, scriptFunc, attemptNumber) {
        return new Promise((resolve, reject) => {
            console.log(`[SCRAPER]     Opening: ${url}${attemptNumber > 0 ? ` (retry ${attemptNumber + 1})` : ''}`);

            // Create tab options - specify window if provided
            const createOptions = { url: url, active: false };
            if (this.targetWindowId) {
                createOptions.windowId = this.targetWindowId;
            }

            chrome.tabs.create(createOptions, (tab) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                let resolved = false;
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        chrome.tabs.remove(tab.id).catch(() => {});
                        reject(new Error('Page load timeout'));
                    }
                }, 30000);

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
                                chrome.tabs.remove(tab.id).catch(() => {});
                                reject(new Error(`Page is showing an error: ${currentTab.url}`));
                                return;
                            }

                            // Additional check: verify the page actually loaded
                            if (!currentTab.url || currentTab.url.startsWith('chrome-error:')) {
                                chrome.tabs.remove(tab.id).catch(() => {});
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
                                chrome.tabs.remove(tab.id).catch(() => {});
                                if (results && results[0] && results[0].result !== undefined) {
                                    resolve(results[0].result);
                                } else {
                                    reject(new Error('No result from script'));
                                }
                            }).catch((error) => {
                                chrome.tabs.remove(tab.id).catch(() => {});
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
}
