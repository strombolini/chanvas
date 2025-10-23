// Automated Canvas scraping orchestrator
// Runs in background service worker to coordinate scraping

class CanvasAutoScraper {
    constructor() {
        this.scrapingInProgress = false;
        this.coursesData = {};
        this.currentTabId = null;
    }

    // Start automated scraping after login detected
    async startAutoScrape() {
        if (this.scrapingInProgress) {
            console.log('Scraping already in progress');
            return;
        }

        console.log('Starting automated Canvas scrape...');
        this.scrapingInProgress = true;
        this.coursesData = {};

        try {
            // Step 1: Get list of all courses
            const courses = await this.scrapeCourseList();
            console.log(`Found ${courses.length} courses:`, courses);

            // Step 2: Scrape each course
            for (const course of courses) {
                await this.scrapeCourse(course);
            }

            // Step 3: Save all data to chrome.storage.local
            await this.saveScrapedData();

            // Step 4: Upload to OpenAI and create Assistant (optional)
            // await this.uploadToOpenAI();

            console.log('Automated scraping complete!');
            this.scrapingInProgress = false;

        } catch (error) {
            console.error('Error during auto-scrape:', error);
            this.scrapingInProgress = false;
        }
    }

    // Scrape courses from dashboard only (current courses)
    async scrapeCourseList() {
        // Dashboard shows only current active courses - exactly what we want
        const url = 'https://canvas.cornell.edu/';
        const pageContent = await this.scrapePageInTab(url);

        // Parse course list from dashboard
        const courses = this.parseCourseList(pageContent);

        console.log(`Found ${courses.length} courses from dashboard (current courses only)`);
        return courses;
    }

    // Parse course list from dashboard - only current courses
    parseCourseList(pageData) {
        const courses = [];

        // Parse from dashboard HTML
        if (pageData.html) {
            // Look for course links - dashboard only shows current courses
            const coursePattern = /\/courses\/(\d+)/g;
            const matches = [...pageData.html.matchAll(coursePattern)];
            const seenIds = new Set();

            console.log(`Found ${matches.length} total course link matches`);

            for (const match of matches) {
                const courseId = match[1];

                // Skip if already processed
                if (seenIds.has(courseId)) {
                    continue;
                }
                seenIds.add(courseId);

                // Try multiple patterns to extract course name
                let courseName = `Course ${courseId}`;

                // Pattern 1: Look for link with course ID and extract text
                const pattern1 = new RegExp(`<a[^>]*href="[^"]*courses/${courseId}[^"]*"[^>]*>([^<]+)</a>`, 'i');
                const match1 = pageData.html.match(pattern1);
                if (match1 && match1[1].trim()) {
                    courseName = match1[1].trim();
                }

                // Pattern 2: Look for course card with title
                const pattern2 = new RegExp(`courses/${courseId}[\\s\\S]{0,500}?<[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)<`, 'i');
                const match2 = pageData.html.match(pattern2);
                if (match2 && match2[1].trim()) {
                    courseName = match2[1].trim();
                }

                console.log(`✓ Found course: ${courseId} - ${courseName}`);
                courses.push({ id: courseId, name: courseName });
            }
        }

        // Method 2: Parse from visible text if HTML parsing failed
        if (courses.length === 0 && pageData.text) {
            const lines = pageData.text.split('\n');
            const coursePattern = /courses\/(\d+)/;

            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(coursePattern);
                if (match) {
                    const courseId = match[1];
                    // Try to get course name from previous or current line
                    const courseName = lines[i-1]?.trim() || lines[i].trim() || `Course ${courseId}`;
                    courses.push({ id: courseId, name: courseName.substring(0, 100) });
                }
            }
        }

        console.log(`Parsed ${courses.length} courses from page`);
        return courses;
    }

    // Filter courses to only include current semester (Fall 2025)
    // Adapted from get_fall_2025_course_ids in canvas_scraper.py
    filterCurrentSemesterCourses(courses, pageData) {
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1; // 1-12

        // Determine current semester based on month
        let currentSemester = '';
        if (currentMonth >= 8 && currentMonth <= 12) {
            currentSemester = `fall ${currentYear}`;
        } else if (currentMonth >= 1 && currentMonth <= 5) {
            currentSemester = `spring ${currentYear}`;
        } else {
            currentSemester = `summer ${currentYear}`;
        }

        console.log(`Filtering for current semester: ${currentSemester}`);

        // Filter courses by checking if term text contains current semester
        return courses.filter(course => {
            // Look for term information in the page HTML near this course
            const coursePattern = new RegExp(`courses/${course.id}[\\s\\S]{0,200}(fall|spring|summer)\\s*\\d{4}`, 'gi');
            const match = pageData.html?.match(coursePattern);

            if (match) {
                const termText = match[0].toLowerCase();
                const hasCurrentTerm = termText.includes(currentSemester.toLowerCase());

                if (hasCurrentTerm) {
                    console.log(`✓ Including: ${course.name} (${course.id}) - current semester`);
                    return true;
                } else {
                    console.log(`✗ Skipping: ${course.name} (${course.id}) - past/future semester`);
                    return false;
                }
            }

            // If no term found in context, check course name for term info
            const courseNameHasTerm = course.name.toLowerCase().includes(currentSemester);
            if (courseNameHasTerm) {
                console.log(`✓ Including: ${course.name} (${course.id}) - term in name`);
                return true;
            }

            // Default: include course if we can't determine (to avoid missing courses)
            console.log(`? Including: ${course.name} (${course.id}) - term unknown, including by default`);
            return true;
        });
    }

    // Scrape all important pages for a single course
    async scrapeCourse(course) {
        console.log(`Scraping course: ${course.name} (${course.id})`);

        const baseUrl = `https://canvas.cornell.edu/courses/${course.id}`;
        const pages = [
            { name: 'home', url: baseUrl },
            { name: 'assignments', url: `${baseUrl}/assignments` },
            { name: 'modules', url: `${baseUrl}/modules` },
            { name: 'syllabus', url: `${baseUrl}/assignments/syllabus` },
            { name: 'announcements', url: `${baseUrl}/announcements` },
            { name: 'grades', url: `${baseUrl}/grades` }
        ];

        this.coursesData[course.id] = {
            id: course.id,
            name: course.name,
            pages: {},
            scrapedAt: Date.now()
        };

        for (const page of pages) {
            try {
                const pageData = await this.scrapePageInTab(page.url);
                this.coursesData[course.id].pages[page.name] = {
                    url: page.url,
                    content: pageData.text,  // Store visible text like canvas_scraper.py
                    html: pageData.html.substring(0, 50000),  // Store limited HTML for parsing
                    textLength: pageData.text.length,
                    title: pageData.title
                };
                console.log(`  ✓ Scraped ${page.name}: ${pageData.text.length} chars`);

                // Small delay between pages to avoid rate limiting
                await this.sleep(500);

            } catch (error) {
                console.error(`  ✗ Failed to scrape ${page.name}:`, error);
                // Continue with next page even if one fails
            }
        }
    }

    // Scrape a single page by opening it in a background tab
    async scrapePageInTab(url) {
        return new Promise((resolve, reject) => {
            console.log(`Opening tab for: ${url}`);

            // Create a new tab
            chrome.tabs.create({ url: url, active: false }, (tab) => {
                if (chrome.runtime.lastError) {
                    console.error('Tab creation error:', chrome.runtime.lastError);
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                this.currentTabId = tab.id;
                let resolved = false;

                // Set timeout first
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        console.error('Page load timeout for:', url);
                        chrome.tabs.remove(tab.id).catch(() => {});
                        reject(new Error('Page load timeout'));
                    }
                }, 30000);

                // Wait for page to load, then extract content
                const listener = (tabId, changeInfo) => {
                    if (tabId === tab.id && changeInfo.status === 'complete' && !resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        chrome.tabs.onUpdated.removeListener(listener);

                        console.log(`Page loaded: ${url}, extracting content...`);

                        // Execute content extraction script (matches canvas_scraper.py logic)
                        chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: () => {
                                // Extract visible text content like get_visible_text() in canvas_scraper.py
                                const text = document.body && document.body.innerText ?
                                    document.body.innerText : document.body.textContent;

                                return {
                                    html: document.body.innerHTML,
                                    text: text,
                                    title: document.title
                                };
                            }
                        }).then((results) => {
                            // Close the tab
                            chrome.tabs.remove(tab.id).catch(() => {});

                            if (results && results[0] && results[0].result) {
                                console.log(`✓ Extracted ${results[0].result.text.length} chars from ${url}`);
                                resolve(results[0].result);
                            } else {
                                console.error('No results from content extraction');
                                reject(new Error('Failed to extract content'));
                            }
                        }).catch((error) => {
                            console.error('Script execution error:', error);
                            chrome.tabs.remove(tab.id).catch(() => {});
                            reject(error);
                        });
                    }
                };

                chrome.tabs.onUpdated.addListener(listener);
            });
        });
    }

    // Save all scraped data to chrome.storage.local
    async saveScrapedData() {
        return new Promise((resolve, reject) => {
            const dataToSave = {
                courses: this.coursesData,
                lastScraped: Date.now(),
                version: '1.0'
            };

            chrome.storage.local.set({ canvasData: dataToSave }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    console.log('Scraped data saved to chrome.storage.local');
                    resolve();
                }
            });
        });
    }

    // Helper: sleep function
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Get scraped data from storage
    async getScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['canvasData'], (result) => {
                resolve(result.canvasData || null);
            });
        });
    }

    // Clear all scraped data
    async clearScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.remove(['canvasData'], () => {
                console.log('Scraped data cleared');
                resolve();
            });
        });
    }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CanvasAutoScraper;
}
