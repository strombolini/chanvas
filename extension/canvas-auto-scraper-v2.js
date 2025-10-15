// Canvas Auto-Scraper v2 - Based on canvas_scraper.py logic
// Matches the flow of run_canvas_scrape_job and get_fall_2025_course_ids

class CanvasAutoScraper {
    constructor() {
        this.scrapingInProgress = false;
        this.coursesData = {};
    }

    // Main entry point - matches run_canvas_scrape_job
    async startAutoScrape(progressCallback) {
        if (this.scrapingInProgress) {
            console.log('Scraping already in progress');
            return;
        }

        console.log('[SCRAPER] Starting automated Canvas scrape...');
        this.scrapingInProgress = true;
        this.coursesData = {};
        this.progressCallback = progressCallback;

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
        const result = await this.executeScriptOnPage('https://canvas.cornell.edu/', () => {
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

                console.log(`[SCRAPER] Found ${courseIds.length} unique course IDs:`, courseIds);
                return courseIds;
            });
        });

        return result || [];
    }

    // Scrape a single course - matches run_course_crawl + crawl_course logic
    async scrapeCourse(courseId) {
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

        // Pages to scrape - matches seeds in crawl_course
        const pages = [
            { name: 'home', url: baseUrl },
            { name: 'assignments', url: `${baseUrl}/assignments` },
            { name: 'modules', url: `${baseUrl}/modules` },
            { name: 'syllabus', url: `${baseUrl}/assignments/syllabus` },
            { name: 'grades', url: `${baseUrl}/grades` },
            { name: 'announcements', url: `${baseUrl}/announcements` }
        ];

        // Scrape each page
        for (const page of pages) {
            try {
                const pageData = await this.executeScriptOnPage(page.url, () => {
                    // Match get_visible_text from canvas_scraper.py
                    return {
                        text: document.body.innerText || document.body.textContent,
                        html: document.body.innerHTML.substring(0, 50000), // Limit HTML size
                        title: document.title
                    };
                });

                this.coursesData[courseId].pages[page.name] = {
                    url: page.url,
                    content: pageData.text,
                    textLength: pageData.text.length,
                    title: pageData.title
                };

                console.log(`[SCRAPER]   ✓ ${page.name}: ${pageData.text.length} chars`);

                // Small delay between pages
                await this.sleep(300);

            } catch (error) {
                console.error(`[SCRAPER]   ✗ Failed to scrape ${page.name}:`, error.message);
            }
        }

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
    async executeScriptOnPage(url, scriptFunc) {
        return new Promise((resolve, reject) => {
            console.log(`[SCRAPER]     Opening: ${url}`);

            chrome.tabs.create({ url: url, active: false }, (tab) => {
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

                const listener = (tabId, changeInfo) => {
                    if (tabId === tab.id && changeInfo.status === 'complete' && !resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
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
                            reject(error);
                        });
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

        // Upload to backend
        await this.uploadToBackend();
    }

    // Upload course data to backend API
    async uploadToBackend() {
        try {
            this.sendProgress('Uploading courses to backend...');

            // Get Chanvas URL and user email from extension storage
            const config = await new Promise((resolve) => {
                chrome.storage.sync.get(['chanvasUrl', 'userEmail'], (result) => {
                    resolve(result);
                });
            });
            const chanvasUrl = config.chanvasUrl || 'http://localhost:8000';
            const userEmail = config.userEmail; // User's Cornell email from OAuth

            // Generate session token from cookies (fallback if no OAuth)
            const cookies = await new Promise((resolve) => {
                chrome.cookies.getAll({ domain: '.cornell.edu' }, (cookies) => {
                    resolve(cookies);
                });
            });
            const sessionToken = JSON.stringify(cookies);

            // Format courses for upload
            const coursesArray = Object.keys(this.coursesData).map(courseId => {
                const course = this.coursesData[courseId];

                // Combine all page content into a single text
                let combinedContent = `Course: ${course.name} (ID: ${courseId})\n\n`;

                for (const pageName in course.pages) {
                    const page = course.pages[pageName];
                    combinedContent += `\n=== ${pageName.toUpperCase()} ===\n`;
                    combinedContent += `URL: ${page.url}\n\n`;
                    combinedContent += page.content;
                    combinedContent += '\n\n';
                }

                return {
                    courseId: courseId,
                    courseName: course.name,
                    content: combinedContent
                };
            });

            // Upload to backend
            const response = await fetch(`${chanvasUrl}/api/upload-courses`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    courses: coursesArray,
                    session_token: sessionToken,
                    user_email: userEmail // Pass OAuth email if available
                })
            });

            if (response.ok) {
                const result = await response.json();
                console.log('[SCRAPER] Upload successful:', result);
                this.sendProgress(`✓ Uploaded ${result.courses.length} courses to backend`);
            } else {
                const error = await response.text();
                console.error('[SCRAPER] Upload failed:', error);
                this.sendProgress('⚠ Upload to backend failed - data saved locally');
            }

        } catch (error) {
            console.error('[SCRAPER] Upload error:', error);
            this.sendProgress('⚠ Upload to backend failed - data saved locally');
        }
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

    // Helper: sleep
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
