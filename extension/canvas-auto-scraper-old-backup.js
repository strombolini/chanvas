// Canvas Auto-Scraper Old - Based on canvas_course_scraper.py logic
// Adapted for Chrome extension with parallelization, syllabus-only mode, and separate window
// NO RAG - stores compressed GPT context to pass directly to GPT-5-nano for chat

class CanvasAutoScraperOld {
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
        
        // Restart tracking for file extraction timeouts
        this.needsRestart = false;
        this.restartReason = null;
        this.restartCourseId = null;
        this.restartFileUrl = null;
        this.restartInProgress = false; // Flag to signal other operations to stop
        
        // Error logging
        this.errorLog = []; // Store detailed error logs
        this.scrapingStartTime = null;
        this.activeOperations = new Map(); // Track active operations for context
        
        // Constants
        this.START_URL = "https://canvas.cornell.edu";
        this.scrapedUrls = new Set(); // Track scraped URLs for incremental scraping
        
        // Tab management - use persistent tabs per course (like Python's single driver instance)
        this.courseTabs = new Map(); // Map courseId -> tabId for persistent tabs
    }
    
    // Stop scraping gracefully
    async stopScraping() {
        console.log('[SCRAPER-OLD] Stop requested by user');
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
            console.log(`[SCRAPER-OLD] Waiting for ${this.activeScrapingPromises.length} active scraping operations to finish...`);
            await Promise.allSettled(this.activeScrapingPromises);
        }
        
        this.sendProgress('✓ Scraping stopped by user. Processing collected data...');
    }

    // Main entry point
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
        this.errorLog = []; // Reset error log
        this.activeOperations.clear();

        // START keep-awake mechanism
        this.startKeepAwake();

        try {
            // Step 1: Get course IDs from dashboard
            this.sendProgress('Discovering courses on dashboard...');
            const courseIds = await this.getDashboardCourseIds();
            console.log(`[SCRAPER-OLD] Found ${courseIds.length} courses: ${courseIds}`);

            if (courseIds.length === 0) {
                console.log('[SCRAPER-OLD] No courses found on dashboard');
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
                const operationId = `course_${courseId}_${Date.now()}`;
                this.activeOperations.set(operationId, `Scraping course ${courseId}`);
                
                const promise = (async () => {
                    try {
                        // Initialize course context with progress info before starting
                        this.currentCourseContext = {
                            courseId: courseId,
                            courseName: this.coursesData[courseId]?.name,
                            completedCourses: completedCourses,
                            totalCourses: totalCourses
                        };
                        
                        return await this.scrapeCourse(courseId);
                    } catch (error) {
                        // Check if this is a restart-required error
                        if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                            // Error should already be logged by the throwing function
                            return 'RESTART_REQUIRED';
                        }
                        
                        // Log detailed error for non-restart errors
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

            const results = await Promise.allSettled(courseScrapingPromises);
            
            // Check if any promise returned RESTART_REQUIRED
            const restartRequired = results.some(result => 
                result.status === 'fulfilled' && result.value === 'RESTART_REQUIRED'
            ) || this.needsRestart;
            
            if (restartRequired) {
                // Log restart summary
                console.error(`\n${'='.repeat(80)}`);
                console.error(`[SCRAPER-OLD] RESTART TRIGGERED - Summary`);
                console.error(`${'='.repeat(80)}`);
                console.error(`Total Errors Logged: ${this.errorLog.length}`);
                console.error(`Error Types:`, [...new Set(this.errorLog.map(e => e.errorType))]);
                console.error(`Restart Reason: ${this.restartReason || 'Unknown'}`);
                console.error(`Course ID: ${this.restartCourseId || 'N/A'}`);
                console.error(`File URL: ${this.restartFileUrl || 'N/A'}`);
                console.error(`Completed Courses: ${completedCourses}/${totalCourses}`);
                console.error(`Active Operations: ${this.activeOperations.size}`);
                console.error(`${'='.repeat(80)}\n`);
                
                console.log('[SCRAPER-OLD] Restart required. Closing tabs and restarting from where we left off...');
                this.sendProgress('Restarting scrape due to timeout error...');
                
                // Ensure all tabs are closed
                await this.closeAllScrapingTabs();
                
                // Wait a bit before restarting
                await this.sleep(2000);
                
                // Recreate the scraping window if needed
                const newWindowId = await this.ensureScrapingWindow();
                if (newWindowId) {
                    this.targetWindowId = newWindowId;
                    console.log(`[SCRAPER-OLD] Created new scraping window: ${newWindowId}`);
                    this.sendProgress('Recreated scraping window...');
                    
                    // Wait for window to be ready
                    await this.sleep(1000);
                } else {
                    console.error('[SCRAPER-OLD] Failed to create scraping window during restart');
                    this.sendProgress('✗ Error: Failed to recreate scraping window');
                    throw new Error('Failed to recreate scraping window');
                }
                
                // Reset restart flags
                this.needsRestart = false;
                this.restartInProgress = false;
                
                  // Get list of fully-completed courses (must have all 7 sections AND fullyCompleted flag)
                // IMPORTANT: If a course was in progress when restart happened, it should NOT be saved
                // Only courses that were fully completed (all 7 sections + fullyCompleted flag) should be kept
                const expectedSections = ['home', 'syllabus', 'modules', 'files', 'assignments', 'announcements', 'pages'];
                const scrapedCourseIds = Object.keys(this.coursesData).filter(id => {
                    const course = this.coursesData[id];
                    if (!course || !course.sections) return false;
                    
                    // Only consider courses that have fullyCompleted flag set
                    // This ensures courses that were in progress when restart happened are re-scraped
                    if (course.fullyCompleted === true) {
                        // Double-check: verify all sections exist and are marked as completed
                        const completedSections = course.completedSections || [];
                        const hasAllSections = expectedSections.every(section => {
                            return completedSections.includes(section);
                        });
                        
                        // Verify sections exist in course data
                        const hasSectionData = expectedSections.every(section => {
                            return course.sections.hasOwnProperty(section);
                        });
                        
                        return hasAllSections && hasSectionData;
                    }
                    
                    // If fullyCompleted is not true, don't consider it scraped - it will be re-scraped
                    return false;
                });
                
                // Filter out already-scraped courses
                const remainingCourseIds = courseIds.filter(id => !scrapedCourseIds.includes(id));
                
                // Also remove courses that were in progress (not fully completed) from coursesData
                // so they get re-scraped from scratch
                courseIds.forEach(id => {
                    if (!scrapedCourseIds.includes(id) && this.coursesData[id]) {
                        // This course was in progress - remove it so it gets re-scraped
                        console.log(`[SCRAPER-OLD] Course ${id} was in progress, will be re-scraped from scratch`);
                        delete this.coursesData[id];
                    }
                });
                
                if (remainingCourseIds.length > 0) {
                    console.log(`[SCRAPER-OLD] Resuming scraping for ${remainingCourseIds.length} remaining course(s): ${remainingCourseIds.join(', ')}`);
                    this.sendProgress(`Resuming scrape for ${remainingCourseIds.length} remaining course(s)...`);
                    
                    // Recursively restart scraping with remaining courses
                    // Reset progress tracking
                    completedCourses = scrapedCourseIds.length;
                    this.sendProgress(`progress:${completedCourses}/${totalCourses}`);
                    
                    // Continue scraping with remaining courses using the same logic
                    // Re-discover course IDs (in case new courses were added)
                    const allCourseIds = await this.getDashboardCourseIds();
                    // Filter to only include remaining courses
                    const coursesToScrape = allCourseIds.filter(id => remainingCourseIds.includes(id));
                    
                    if (coursesToScrape.length > 0) {
                        // Reset progress tracking
                        this.activeScrapingPromises = [];
                        
                        // Continue scraping remaining courses
                        const remainingPromises = coursesToScrape.map((courseId) => {
                            const operationId = `course_${courseId}_restart_${Date.now()}`;
                            this.activeOperations.set(operationId, `Scraping course ${courseId} (restart)`);
                            
                            const promise = (async () => {
                                try {
                                    // Initialize course context with progress info before starting
                                    this.currentCourseContext = {
                                        courseId: courseId,
                                        courseName: this.coursesData[courseId]?.name,
                                        completedCourses: completedCourses,
                                        totalCourses: totalCourses
                                    };
                                    
                                    return await this.scrapeCourse(courseId);
                                } catch (error) {
                                    // Check if this is a restart-required error
                                    if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                                        // Error should already be logged by the throwing function
                                        return 'RESTART_REQUIRED';
                                    }
                                    
                                    // Log detailed error for non-restart errors
                                    this.logDetailedError({
                                        errorType: 'COURSE_SCRAPING_ERROR_RESTART',
                                        errorMessage: error.message || 'Unknown error',
                                        errorStack: error.stack,
                                        courseId: courseId,
                                        courseName: this.coursesData[courseId]?.name,
                                        operation: 'scrapeCourse (restart)',
                                        completedCourses: completedCourses,
                                        totalCourses: totalCourses,
                                        currentPhase: 'course_scraping_restart'
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
                        
                        await Promise.allSettled(remainingPromises);
                        
                        // After scraping remaining courses, continue to post-processing
                        // (fall through to post-processing below)
                    } else {
                        console.log('[SCRAPER-OLD] All courses already scraped, proceeding with post-processing...');
                    }
                } else {
                    console.log('[SCRAPER-OLD] All courses already scraped, proceeding with post-processing...');
                }
                
                // After restart is handled, continue to post-processing
                // (this will execute after the restart logic completes)
            }
            
            // Only proceed to post-processing if we didn't restart or if restart completed
            if (this.stopRequested) {
                this.sendProgress('✓ Scraping stopped. Processing collected data...');
            } else {
                this.sendProgress('✓ Scraping complete! Processing data...');
            }

            // Step 3: Post-process scraped data
            console.log('[SCRAPER-OLD] Post-processing scraped data...');
            this.sendProgress('Post-processing scraped data...');

            // Remove HTML from corpus
            this.sendProgress('Removing HTML from corpus...');
            await this.removeHtmlFromCorpus();

            // Step 4: Process with GPT (restructure corpus into compressed context)
            this.sendProgress('Restructuring corpus with GPT...');
            await this.restructureCorpusWithGPT();

            // Step 5: Save to storage (no RAG indexing - just store compressed context)
            await this.saveScrapedData();

            this.sendProgress('✓ All done!');
            console.log('[SCRAPER-OLD] Scraping complete');
            
            // Log final error summary if any errors occurred
            if (this.errorLog.length > 0) {
                console.error(`\n${'='.repeat(80)}`);
                console.error(`[SCRAPER-OLD] FINAL ERROR SUMMARY`);
                console.error(`${'='.repeat(80)}`);
                console.error(`Total Errors: ${this.errorLog.length}`);
                console.error(`Error Types:`, [...new Set(this.errorLog.map(e => e.errorType))].join(', '));
                console.error(`\nErrors by Type:`);
                const errorsByType = {};
                this.errorLog.forEach(e => {
                    errorsByType[e.errorType] = (errorsByType[e.errorType] || 0) + 1;
                });
                Object.entries(errorsByType).forEach(([type, count]) => {
                    console.error(`  ${type}: ${count}`);
                });
                console.error(`\nScraping completed with ${this.errorLog.length} error(s) logged.`);
                console.error(`${'='.repeat(80)}\n`);
            }

        } catch (error) {
            console.error('[SCRAPER-OLD] Error during auto-scrape:', error);
            this.sendProgress(`✗ Error: ${error.message}`);
        } finally {
            this.scrapingInProgress = false;
            this.stopKeepAwake();
        }
    }

    // Get course IDs from dashboard
    async getDashboardCourseIds() {
        console.log('[SCRAPER-OLD] Getting course IDs from dashboard...');

        const allCourseIds = await this.executeScriptOnPage('https://canvas.cornell.edu/', () => {
            const waitStart = Date.now();
            let coursesFound = false;
            
            while (Date.now() - waitStart < 10000) {
                const courseLinks = document.querySelectorAll('a[href*="/courses/"]');
                if (courseLinks.length > 0) {
                    coursesFound = true;
                    break;
                }
                const checkStart = Date.now();
                while (Date.now() - checkStart < 100) {}
            }
            
            const courseIds = new Set();
            const links = document.querySelectorAll('a[href*="/courses/"]');
            for (const link of links) {
                const href = link.getAttribute('href');
                if (href) {
                    const match = href.match(/\/courses\/(\d+)/);
                    if (match && match[1]) {
                        courseIds.add(match[1]);
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
            console.log(`[SCRAPER-OLD] Excluded ${excludedCount} course(s): ${this.excludedCourseIds.filter(id => allCourseIds.includes(id)).join(', ')}`);
        }

        console.log(`[SCRAPER-OLD] Proceeding with ${filteredCourseIds.length} course(s) after filtering`);
        return filteredCourseIds;
    }

    // Extract course ID from URL
    extractCourseId(url) {
        const match = url.match(/\/courses\/(\d+)/);
        return match ? match[1] : null;
    }

    // Scrape a single course - based on CanvasCourseScraper.scrape_all()
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
            sections: {},
            files: [],
            externalLinks: [],
            scrapedAt: Date.now()
        };

        try {
            // Get course name from home page
            const courseName = await this.getCourseTitle(courseId, baseUrl);
            this.coursesData[courseId].name = courseName;
            console.log(`[SCRAPER-OLD]   Course name: ${courseName}`);

            if (this.stopRequested) return;

            // Check if restart is in progress before starting
            if (this.restartInProgress) {
                this.logDetailedError({
                    errorType: 'RESTART_IN_PROGRESS',
                    errorMessage: 'Attempted to scrape course while restart is in progress',
                    errorStack: new Error().stack,
                    courseId: courseId,
                    courseName: this.coursesData[courseId]?.name,
                    operation: 'scrapeCourse (start)',
                    scrapingSection: 'course_initialization',
                    additionalContext: {
                        errorCategory: 'RESTART_STATE_ERROR',
                        requiresRestart: false
                    }
                });
                
                const restartError = new Error('RESTART_REQUIRED: Restart in progress');
                restartError.isRestartRequired = true;
                throw restartError;
            }

            // Course context should already be set by caller, but ensure it's set
            if (!this.currentCourseContext) {
                this.currentCourseContext = {
                    courseId: courseId,
                    courseName: this.coursesData[courseId]?.name,
                    completedCourses: 0,
                    totalCourses: 0
                };
            } else {
                // Update with current course info
                this.currentCourseContext.courseId = courseId;
                this.currentCourseContext.courseName = this.coursesData[courseId]?.name || this.currentCourseContext.courseName;
            }

              // [1/7] Scrape course home page
              this.currentCourseContext.scrapingSection = 'home';
              try {
                  await this.scrapeHomePage(courseId, baseUrl);
                  this.checkpointSection(courseId, 'home');
                  await this.saveScrapedData(); // Save progress after each section
              } catch (error) {
                  // Log but continue - don't fail entire course (like Python scraper)
                  if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                      console.error(`[SCRAPER-OLD] Home page scrape failed for ${courseId}, continuing...`);
                  } else {
                      throw error;
                  }
              }

              if (this.stopRequested || this.restartInProgress) return;

              // [2/7] Scrape syllabus
              this.currentCourseContext.scrapingSection = 'syllabus';
              try {
                  await this.scrapeSyllabus(courseId, baseUrl);
                  this.checkpointSection(courseId, 'syllabus');
                  await this.saveScrapedData();
              } catch (error) {
                  if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                      console.error(`[SCRAPER-OLD] Syllabus scrape failed for ${courseId}, continuing...`);
                  } else {
                      throw error;
                  }
              }

              if (this.stopRequested || this.restartInProgress) return;

              // [3/7] Scrape modules
              this.currentCourseContext.scrapingSection = 'modules';
              try {
                  await this.scrapeModules(courseId, baseUrl);
                  this.checkpointSection(courseId, 'modules');
                  await this.saveScrapedData();
              } catch (error) {
                  if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                      console.error(`[SCRAPER-OLD] Modules scrape failed for ${courseId}, continuing...`);
                  } else {
                      throw error;
                  }
              }

            if (this.stopRequested || this.restartInProgress) return;

            // [4/7] Scrape files section
            this.currentCourseContext.scrapingSection = 'files';
            try {
                await this.scrapeFilesSection(courseId, baseUrl);
                this.checkpointSection(courseId, 'files');
                await this.saveScrapedData();
            } catch (error) {
                if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                    console.error(`[SCRAPER-OLD] Files section scrape failed for ${courseId}, continuing...`);
                } else {
                    throw error;
                }
            }

            if (this.stopRequested || this.restartInProgress) return;

            // [5/7] Scrape assignments
            this.currentCourseContext.scrapingSection = 'assignments';
            try {
                await this.scrapeAssignments(courseId, baseUrl);
                this.checkpointSection(courseId, 'assignments');
                await this.saveScrapedData();
            } catch (error) {
                if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                    console.error(`[SCRAPER-OLD] Assignments scrape failed for ${courseId}, continuing...`);
                } else {
                    throw error;
                }
            }

            if (this.stopRequested || this.restartInProgress) return;

            // [6/7] Scrape announcements
            this.currentCourseContext.scrapingSection = 'announcements';
            try {
                await this.scrapeAnnouncements(courseId, baseUrl);
                this.checkpointSection(courseId, 'announcements');
                await this.saveScrapedData();
            } catch (error) {
                if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                    console.error(`[SCRAPER-OLD] Announcements scrape failed for ${courseId}, continuing...`);
                } else {
                    throw error;
                }
            }

            if (this.stopRequested || this.restartInProgress) return;

            // [7/7] Scrape additional pages
            this.currentCourseContext.scrapingSection = 'pages';
            try {
                await this.scrapePages(courseId, baseUrl);
                this.checkpointSection(courseId, 'pages');
                await this.saveScrapedData();
            } catch (error) {
                if (error.message !== 'RESTART_REQUIRED' && !error.isRestartRequired) {
                    console.error(`[SCRAPER-OLD] Pages scrape failed for ${courseId}, continuing...`);
                } else {
                    throw error;
                }
            }
            
            // Clear current course context
            this.currentCourseContext = null;

            // Mark course as fully completed (all 7 sections done)
            if (this.coursesData[courseId]) {
                const expectedSections = ['home', 'syllabus', 'modules', 'files', 'assignments', 'announcements', 'pages'];
                const completedSections = this.coursesData[courseId].completedSections || [];
                const allCompleted = expectedSections.every(section => completedSections.includes(section));
                
                if (allCompleted) {
                    this.coursesData[courseId].fullyCompleted = true;
                    this.coursesData[courseId].completedAt = Date.now();
                }
            }
            
            // Close persistent tab for this course (but don't remove from map yet - let it be cleaned up later)
            // Actually, keep it open for now in case we need to restart - will be cleaned up in closeAllScrapingTabs

            console.log(`[SCRAPER-OLD]   Completed course ${courseId}`);
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            // Log detailed error
            this.logDetailedError({
                errorType: 'COURSE_SCRAPING_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: this.currentCourseContext?.scrapingSection || 'unknown',
                operation: 'scrapeCourse',
                completedCourses: this.currentCourseContext?.completedCourses || 0,
                totalCourses: this.currentCourseContext?.totalCourses || 0,
                currentPhase: 'course_scraping',
                additionalContext: {
                    errorCategory: 'COURSE_ERROR'
                }
            });
        } finally {
            this.currentCourseContext = null;
        }
    }

    // Get course title - based on scrape_home_page()
    async getCourseTitle(courseId, baseUrl) {
        try {
            const titleData = await this.executeScriptOnPage(baseUrl, () => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {} // Wait for page load
                
                try {
                    const h1 = document.querySelector('h1');
                    if (h1 && h1.textContent) {
                        return h1.textContent.trim();
                    }
                } catch (e) {}
                
                try {
                    return document.title.trim();
                } catch (e) {
                    return '';
                }
            }, 1);
            
            if (titleData) {
                return this.sanitize(titleData);
            }
            return `Course ${courseId}`;
        } catch (e) {
            return `Course ${courseId}`;
        }
    }

    // Sanitize course name
    sanitize(name) {
        return (name || "").trim().replace(/[^\w\s-]/g, "_") || "Course";
    }

    // [1/7] Scrape home page - based on scrape_home_page()
    async scrapeHomePage(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [1/7] Scraping home page for course ${courseId}`);

        try {
            const pageData = await this.executeScriptOnPage(baseUrl, () => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {}

                // Extract text content
                let textContent = '';
                try {
                    const scripts = document.querySelectorAll('script, style');
                    scripts.forEach(el => el.remove());

                    textContent = document.body ? document.body.innerText || document.body.textContent || '' : '';
                    textContent = textContent.replace(/[ \t\r\f\v]+/g, ' ');
                    textContent = textContent.replace(/\n\s*\n+/g, '\n\n');
                    textContent = textContent.trim();
                } catch (e) {
                    textContent = '';
                }

                return {
                    textContent: textContent,
                    html: document.documentElement.outerHTML,
                    title: document.title || ''
                };
            }, 1);

            if (pageData && pageData.textContent) {
                this.coursesData[courseId].sections.home = {
                    content: pageData.textContent,
                    title: pageData.title || 'Home Page',
                    html: pageData.html.substring(0, 50000) // Limit HTML size
                };
                  console.log(`[SCRAPER-OLD]   ✓ Saved home page (${pageData.textContent.length} chars)`);
              }
          } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'HOME_PAGE_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'home',
                url: baseUrl,
                operation: 'scrapeHomePage',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
          }
      }

    // [2/7] Scrape syllabus - based on scrape_syllabus()
    async scrapeSyllabus(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [2/7] Scraping syllabus for course ${courseId}`);

        const url = `${baseUrl}/assignments/syllabus`;
        
        try {
            const pageData = await this.executeScriptOnPage(url, () => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {}

                let textContent = '';
                try {
                    const scripts = document.querySelectorAll('script, style');
                    scripts.forEach(el => el.remove());
                    textContent = document.body ? document.body.innerText || document.body.textContent || '' : '';
                    textContent = textContent.replace(/[ \t\r\f\v]+/g, ' ');
                    textContent = textContent.replace(/\n\s*\n+/g, '\n\n');
                    textContent = textContent.trim();
                } catch (e) {
                    textContent = '';
                }

                // Find syllabus file links
                const links = Array.from(document.querySelectorAll('a[href]'));
                const syllabusFileLinks = links
                    .map(a => ({
                        href: a.getAttribute('href'),
                        text: (a.textContent || '').trim()
                    }))
                    .filter(link => {
                        const href = link.href || '';
                        const text = link.text.toLowerCase();
                        return (text.includes('syllabus') || href.includes('syllabus')) &&
                               (href.endsWith('.pdf') || href.endsWith('.docx') || href.endsWith('.doc'));
                    });

                return {
                    textContent: textContent,
                    title: document.title || 'Syllabus',
                    syllabusFileLinks: syllabusFileLinks
                };
            }, 1);

            if (pageData && pageData.textContent) {
                this.coursesData[courseId].sections.syllabus = {
                    content: pageData.textContent,
                    title: pageData.title || 'Syllabus'
                };

                  // Extract text from syllabus files
                  for (const link of pageData.syllabusFileLinks || []) {
                      if (this.stopRequested || this.restartInProgress) break;
                      
                      const fullUrl = link.href.startsWith('http') ? link.href : new URL(link.href, url).href;
                      try {
                          const fileContent = await this.extractFileFromCanvas(fullUrl, courseId);
                          if (fileContent) {
                              if (!this.coursesData[courseId].sections.syllabus.files) {
                                  this.coursesData[courseId].sections.syllabus.files = [];
                              }
                              this.coursesData[courseId].sections.syllabus.files.push({
                                  name: link.text || 'syllabus_file',
                                  content: fileContent
                              });
                          }
                      } catch (error) {
                          if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                              throw error;
                          }
                          console.error(`[SCRAPER-OLD]   ✗ Error extracting syllabus file ${link.text || fullUrl}, continuing...`);
                      }
                }

                console.log(`[SCRAPER-OLD]   ✓ Saved syllabus (${pageData.textContent.length} chars)`);
            }
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'SYLLABUS_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'syllabus',
                url: url,
                operation: 'scrapeSyllabus',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
        }
    }

    // [3/7] Scrape modules - based on scrape_modules()
    async scrapeModules(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [3/7] Scraping modules for course ${courseId}`);

        const url = `${baseUrl}/modules`;
        
        try {
            // First, click "Expand All" button and wait
            await this.executeScriptOnPage(url, () => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {}

                // Click "Expand All" button if it exists
                try {
                    const expandBtn = document.querySelector('button[id*="expand"], button[class*="expand"], button[aria-label*="Expand"], button[aria-label*="expand"]');
                    if (expandBtn) {
                        expandBtn.click();
                        // Wait for expansion
                        const expandWait = Date.now();
                        while (Date.now() - expandWait < 2000) {}
                    }
                } catch (e) {
                    // No expand button or already expanded
                }
            }, 1);

            await this.sleep(2000); // Wait after expansion

                          // Now scrape module content
              const moduleData = await this.executeScriptOnPage(url, () => {
                  const waitStart = Date.now();
                  while (Date.now() - waitStart < 2000) {}

                  // Extract course ID from current URL
                  const currentUrl = window.location.href;
                  const courseIdMatch = currentUrl.match(/\/courses\/(\d+)/);
                  const currentCourseId = courseIdMatch ? courseIdMatch[1] : null;

                  // Find all modules
                  const modules = Array.from(document.querySelectorAll('div[class*="context_module"], div[role="region"][aria-label*="module" i]'));

                  const moduleList = [];
                  for (const module of modules) {
                      // Get module name
                      let moduleName = '';
                      const header = module.querySelector('h2, h3, span[class*="header"], span[class*="title"]');
                      if (header) {
                          moduleName = (header.textContent || '').trim();
                      }
                      if (!moduleName) {
                          moduleName = `Module_${moduleList.length + 1}`;
                      }

                      // Find all items in this module
                      const items = Array.from(module.querySelectorAll('a[href]'));
                      const moduleItems = [];

                      for (const item of items) {
                          const href = item.getAttribute('href');
                          const itemText = (item.textContent || '').trim();

                          if (!href || href.startsWith('#')) continue;

                          const fullUrl = href.startsWith('http') ? href : new URL(href, window.location.href).href;

                          if (fullUrl.includes('/files/')) {
                              moduleItems.push({
                                  type: 'file',
                                  name: itemText,
                                  url: fullUrl
                              });
                          } else if (fullUrl.includes('/pages/')) {
                              moduleItems.push({
                                  type: 'page',
                                  name: itemText,
                                  url: fullUrl
                              });
                          } else if (fullUrl.includes('/assignments/')) {
                              moduleItems.push({
                                  type: 'assignment',
                                  name: itemText,
                                  url: fullUrl
                              });
                          } else if (currentCourseId && fullUrl.includes(`/courses/${currentCourseId}/`)) {
                              moduleItems.push({
                                  type: 'link',
                                  name: itemText,
                                  url: fullUrl
                              });
                          } else {
                              moduleItems.push({
                                  type: 'external_link',
                                  name: itemText,
                                  url: fullUrl
                              });
                          }
                      }

                      moduleList.push({
                          name: moduleName,
                          items: moduleItems
                      });
                  }

                  return moduleList;
              }, 1);

            if (moduleData && moduleData.length > 0) {
                this.coursesData[courseId].sections.modules = [];

                // Process each module and its items
                for (const module of moduleData) {
                    if (this.stopRequested) break;

                    const moduleContent = {
                        name: module.name,
                        items: []
                    };

                    for (const item of module.items || []) {
                        if (this.stopRequested) break;

                        // Syllabus-only mode filtering
                        if (this.syllabusOnlyMode) {
                            const hasSyllabus = item.url.toLowerCase().includes('syllabus') ||
                                              item.name.toLowerCase().includes('syllabus');
                            if (!hasSyllabus) continue;
                        }

                          if (item.type === 'file') {
                            try {
                                const fileContent = await this.extractFileFromCanvas(item.url, courseId);
                                if (fileContent) {
                                    moduleContent.items.push({
                                        type: 'file',
                                        name: item.name,
                                        content: fileContent
                                    });
                                }
                            } catch (error) {
                                if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                                    throw error;
                                }
                                console.error(`[SCRAPER-OLD]   ✗ Error extracting module file ${item.name}, continuing...`);
                            }
                        } else if (item.type === 'page') {
                            const pageContent = await this.scrapePage(item.url, courseId);
                            if (pageContent) {
                                moduleContent.items.push({
                                    type: 'page',
                                    name: item.name,
                                    content: pageContent
                                });
                            }
                        } else if (item.type === 'assignment') {
                            const assignContent = await this.scrapeAssignment(item.url, courseId);
                            if (assignContent) {
                                moduleContent.items.push({
                                    type: 'assignment',
                                    name: item.name,
                                    content: assignContent
                                });
                            }
                        } else {
                            moduleContent.items.push(item); // External links, etc.
                        }
                    }

                    this.coursesData[courseId].sections.modules.push(moduleContent);
                }

                console.log(`[SCRAPER-OLD]   ✓ Processed ${moduleData.length} modules`);
            }
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'MODULES_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'modules',
                url: url,
                operation: 'scrapeModules',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
        }
    }

    // [4/7] Scrape files section - based on scrape_files_section()
    async scrapeFilesSection(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [4/7] Scraping files section for course ${courseId}`);

        const url = `${baseUrl}/files`;
        
        try {
              const fileLinks = await this.executeScriptOnPage(url, () => {
                  const waitStart = Date.now();
                  while (Date.now() - waitStart < 3000) {}

                  const links = Array.from(document.querySelectorAll('a[href*="/files/"]'));
                  return links.map(a => ({
                      href: a.getAttribute('href'),
                      text: (a.textContent || '').trim()
                  })).filter(link => link.href && link.href.includes('/files/'));
              }, 1, this.currentCourseContext);

            if (fileLinks && fileLinks.length > 0) {
                const downloadedFiles = [];

                  for (const link of fileLinks) {
                      if (this.stopRequested || this.restartInProgress) break;

                      // Syllabus-only mode filtering
                      if (this.syllabusOnlyMode) {
                          const hasSyllabus = link.href.toLowerCase().includes('syllabus') ||
                                            link.text.toLowerCase().includes('syllabus');
                          if (!hasSyllabus) continue;
                      }

                      const fullUrl = link.href.startsWith('http') ? link.href : new URL(link.href, url).href;
                      
                      // Try to extract file, but continue on error (like Python scraper)
                      try {
                          const fileContent = await this.extractFileFromCanvas(fullUrl, courseId);
                          if (fileContent) {
                              downloadedFiles.push({
                                  name: link.text || 'file',
                                  content: fileContent
                              });
                          }
                      } catch (error) {
                          // Log error but continue - don't fail entire course on single file error
                          if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                              throw error; // Only throw restart errors
                          }
                          console.error(`[SCRAPER-OLD]   ✗ Error extracting file ${link.text || fullUrl}, continuing...`);
                      }
                }

                this.coursesData[courseId].sections.files = downloadedFiles;
                console.log(`[SCRAPER-OLD]   ✓ Downloaded ${downloadedFiles.length} files from Files section`);
            }
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'FILES_SECTION_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'files',
                url: url,
                operation: 'scrapeFilesSection',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
        }
    }

    // [5/7] Scrape assignments - based on scrape_assignments()
    async scrapeAssignments(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [5/7] Scraping assignments for course ${courseId}`);

        const url = `${baseUrl}/assignments`;
        
        try {
              const assignmentLinks = await this.executeScriptOnPage(url, () => {
                  const waitStart = Date.now();
                  while (Date.now() - waitStart < 2000) {}

                  const links = Array.from(document.querySelectorAll('a[href*="/assignments/"]'));
                  return links.map(a => ({
                      href: a.getAttribute('href'),
                      text: (a.textContent || '').trim()
                  })).filter(link => link.href && link.href.includes('/assignments/'));
              }, 1, this.currentCourseContext);

            if (assignmentLinks && assignmentLinks.length > 0) {
                const assignmentsData = [];

                for (const link of assignmentLinks) {
                    if (this.stopRequested) break;

                    const fullUrl = link.href.startsWith('http') ? link.href : new URL(link.href, url).href;
                    const assignContent = await this.scrapeAssignment(fullUrl, courseId);

                    if (assignContent) {
                        assignmentsData.push({
                            name: link.text || 'Assignment',
                            content: assignContent
                        });
                    }
                }

                this.coursesData[courseId].sections.assignments = assignmentsData;
                console.log(`[SCRAPER-OLD]   ✓ Scraped ${assignmentsData.length} assignments`);
            }
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'ASSIGNMENTS_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'assignments',
                url: url,
                operation: 'scrapeAssignments',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
        }
    }

    // [6/7] Scrape announcements - based on scrape_announcements()
    async scrapeAnnouncements(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [6/7] Scraping announcements for course ${courseId}`);

        const url = `${baseUrl}/announcements`;
        
        try {
              const pageData = await this.executeScriptOnPage(url, () => {
                  const waitStart = Date.now();
                  while (Date.now() - waitStart < 2000) {}

                  let textContent = '';
                  try {
                      const scripts = document.querySelectorAll('script, style');
                      scripts.forEach(el => el.remove());
                      textContent = document.body ? document.body.innerText || document.body.textContent || '' : '';
                      textContent = textContent.replace(/[ \t\r\f\v]+/g, ' ');
                      textContent = textContent.replace(/\n\s*\n+/g, '\n\n');
                      textContent = textContent.trim();
                  } catch (e) {
                      textContent = '';
                  }

                  return {
                      textContent: textContent,
                      title: document.title || 'Announcements'
                  };
              }, 1, this.currentCourseContext);

            if (pageData && pageData.textContent) {
                this.coursesData[courseId].sections.announcements = {
                    content: pageData.textContent,
                    title: pageData.title || 'Announcements'
                };
                console.log(`[SCRAPER-OLD]   ✓ Saved announcements (${pageData.textContent.length} chars)`);
            }
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'ANNOUNCEMENTS_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'announcements',
                url: url,
                operation: 'scrapeAnnouncements',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
        }
    }

    // [7/7] Scrape additional pages - based on scrape_pages()
    async scrapePages(courseId, baseUrl) {
        console.log(`[SCRAPER-OLD]   [7/7] Scraping pages for course ${courseId}`);

        const url = `${baseUrl}/pages`;
        
        try {
              const pageLinks = await this.executeScriptOnPage(url, () => {
                  const waitStart = Date.now();
                  while (Date.now() - waitStart < 2000) {}

                  const links = Array.from(document.querySelectorAll('a[href*="/pages/"]'));
                  return links.map(a => ({
                      href: a.getAttribute('href'),
                      text: (a.textContent || '').trim()
                  })).filter(link => link.href && link.href.includes('/pages/'));
              }, 1, this.currentCourseContext);

            if (pageLinks && pageLinks.length > 0) {
                const pagesData = [];

                for (const link of pageLinks) {
                    if (this.stopRequested) break;

                    const fullUrl = link.href.startsWith('http') ? link.href : new URL(link.href, url).href;
                    const pageContent = await this.scrapePage(fullUrl, courseId);

                    if (pageContent) {
                        pagesData.push({
                            name: link.text || 'Page',
                            content: pageContent
                        });
                    }
                }

                this.coursesData[courseId].sections.pages = pagesData;
                console.log(`[SCRAPER-OLD]   ✓ Scraped ${pagesData.length} pages`);
            }
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'PAGES_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'pages',
                url: url,
                operation: 'scrapePages',
                additionalContext: {
                    errorCategory: 'SECTION_ERROR'
                }
            });
        }
    }

    // Scrape a Canvas page - based on _scrape_page()
    async scrapePage(url, courseId) {
        if (this.scrapedUrls && this.scrapedUrls.has(url)) {
            return null;
        }
        if (!this.scrapedUrls) {
            this.scrapedUrls = new Set();
        }
        this.scrapedUrls.add(url);

        try {
            const pageData = await this.executeScriptOnPage(url, () => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {}

                let textContent = '';
                try {
                    const scripts = document.querySelectorAll('script, style');
                    scripts.forEach(el => el.remove());
                    textContent = document.body ? document.body.innerText || document.body.textContent || '' : '';
                    textContent = textContent.replace(/[ \t\r\f\v]+/g, ' ');
                    textContent = textContent.replace(/\n\s*\n+/g, '\n\n');
                    textContent = textContent.trim();
                } catch (e) {
                    textContent = '';
                }

                // Look for embedded file links
                const fileLinks = Array.from(document.querySelectorAll('a[href*="/files/"]'))
                    .map(a => a.getAttribute('href'))
                    .filter(href => href && href.includes('/files/'));

                return {
                    textContent: textContent,
                    fileLinks: fileLinks
                };
            }, 1);

            if (!pageData || !pageData.textContent) {
                return null;
            }

              // Extract text from embedded files
              let fullContent = pageData.textContent;
              for (const fileLink of pageData.fileLinks || []) {
                  if (this.stopRequested || this.restartInProgress) break;
                  
                  const fullUrl = fileLink.startsWith('http') ? fileLink : new URL(fileLink, url).href;
                  try {
                      const fileContent = await this.extractFileFromCanvas(fullUrl, courseId);
                      if (fileContent) {
                          fullContent += '\n\n[Embedded File Content]\n\n' + fileContent;
                      }
                  } catch (error) {
                      if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                          throw error;
                      }
                      console.error(`[SCRAPER-OLD]   ✗ Error extracting embedded file, continuing...`);
                  }
            }

            return fullContent;
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'PAGE_SCRAPING_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name || this.currentCourseContext?.courseName,
                scrapingSection: this.currentCourseContext?.scrapingSection || 'page',
                url: url,
                operation: 'scrapePage',
                additionalContext: {
                    errorCategory: 'PAGE_ERROR'
                }
            });
            
            return null;
        }
    }

    // Scrape an assignment - based on _scrape_assignment()
    async scrapeAssignment(url, courseId) {
        if (this.scrapedUrls && this.scrapedUrls.has(url)) {
            return null;
        }
        if (!this.scrapedUrls) {
            this.scrapedUrls = new Set();
        }
        this.scrapedUrls.add(url);

        try {
            const pageData = await this.executeScriptOnPage(url, () => {
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2000) {}

                let textContent = '';
                try {
                    const scripts = document.querySelectorAll('script, style');
                    scripts.forEach(el => el.remove());
                    textContent = document.body ? document.body.innerText || document.body.textContent || '' : '';
                    textContent = textContent.replace(/[ \t\r\f\v]+/g, ' ');
                    textContent = textContent.replace(/\n\s*\n+/g, '\n\n');
                    textContent = textContent.trim();
                } catch (e) {
                    textContent = '';
                }

                // Look for attached file links
                const fileLinks = Array.from(document.querySelectorAll('a[href*="/files/"]'))
                    .map(a => a.getAttribute('href'))
                    .filter(href => href && href.includes('/files/'));

                return {
                    textContent: textContent,
                    fileLinks: fileLinks
                };
            }, 1);

            if (!pageData || !pageData.textContent) {
                return null;
            }

              // Extract text from attached files
              let fullContent = pageData.textContent;
              for (const fileLink of pageData.fileLinks || []) {
                  if (this.stopRequested || this.restartInProgress) break;
                  
                  const fullUrl = fileLink.startsWith('http') ? fileLink : new URL(fileLink, url).href;
                  try {
                      const fileContent = await this.extractFileFromCanvas(fullUrl, courseId);
                      if (fileContent) {
                          fullContent += '\n\n[Attached File Content]\n\n' + fileContent;
                      }
                  } catch (error) {
                      if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                          throw error;
                      }
                      console.error(`[SCRAPER-OLD]   ✗ Error extracting attached file, continuing...`);
                  }
            }

            return fullContent;
        } catch (error) {
            // Re-throw RESTART_REQUIRED errors to propagate up
            if (error.message === 'RESTART_REQUIRED' || error.isRestartRequired) {
                throw error;
            }
            
            this.logDetailedError({
                errorType: 'ASSIGNMENT_SCRAPING_ERROR',
                errorMessage: error.message || 'Unknown error',
                errorStack: error.stack,
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name || this.currentCourseContext?.courseName,
                scrapingSection: this.currentCourseContext?.scrapingSection || 'assignment',
                url: url,
                operation: 'scrapeAssignment',
                additionalContext: {
                    errorCategory: 'ASSIGNMENT_ERROR'
                }
            });
            
            return null;
        }
    }

    // Extract file from Canvas (read-only, no download) - based on _download_file() and _extract_text_from_file()
    // Python version: navigates to file, waits, then extracts text
    // Python handles errors gracefully - continues on file errors, doesn't fail entire scrape
    async extractFileFromCanvas(fileUrl, courseId) {
        if (this.scrapedUrls && this.scrapedUrls.has(fileUrl)) {
            return null;
        }
        if (!this.scrapedUrls) {
            this.scrapedUrls = new Set();
        }
        this.scrapedUrls.add(fileUrl);

        // Preserve course context for error logging (extractFileFromCanvas can be called from various contexts)
        const preservedContext = this.currentCourseContext ? { ...this.currentCourseContext } : null;
        // Ensure context has courseId for error logging
        if (!this.currentCourseContext && courseId) {
            this.currentCourseContext = {
                courseId: courseId,
                courseName: this.coursesData[courseId]?.name,
                scrapingSection: 'file_extraction'
            };
        } else if (this.currentCourseContext && courseId) {
            this.currentCourseContext.courseId = courseId;
            this.currentCourseContext.courseName = this.currentCourseContext.courseName || this.coursesData[courseId]?.name;
        }

        try {
            console.log(`[SCRAPER-OLD]   [FILE] Extracting text from: ${fileUrl}`);

            // Extract text from file (PDFs use TextLayer-container, others use body)
            const fileContent = await this.executeScriptOnPage(fileUrl, () => {
                // Wait for file to render
                const waitStart = Date.now();
                while (Date.now() - waitStart < 3000) {}

                // Wait for TextLayer to appear (for PDFs)
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

                let allText = '';
                
                // Scroll internal containers first (for PDFs)
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
                    container.scrollTop = 0;
                }
                
                // Scroll window
                const scrollStart = Date.now();
                while (Date.now() - scrollStart < 500) {
                    window.scrollTo(0, document.body.scrollHeight);
                }
                window.scrollTo(0, 0);
                
                // Try TextLayer extraction (for PDFs)
                const textLayerElements = document.querySelectorAll('.TextLayer-container .textLayer, .textLayer');
                if (textLayerElements.length > 0) {
                    for (const layer of textLayerElements) {
                        const layerText = layer.innerText || layer.textContent || '';
                        if (layerText.trim()) {
                            allText += (allText ? '\n\n' : '') + layerText;
                        } else {
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
                
                // Fallback: extract from body
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

                // Remove script/style tags before extracting
                const scripts = document.querySelectorAll('script, style');
                scripts.forEach(el => el.remove());

                return document.body.innerText || document.body.textContent || '';
            }, 1);

            if (!fileContent || fileContent.length < 80) {
                return null;
            }

            console.log(`[SCRAPER-OLD]   ✓ Extracted ${fileContent.length} chars from ${fileUrl}`);
            return fileContent;

        } catch (error) {
            // Check if this is a timeout error
            if (error.message && error.message.includes('Timeout waiting for page to load')) {
                // Log detailed error before triggering restart
                // Ensure we have course context - if currentCourseContext is not set, try to infer from courseId
                const errorCourseId = courseId || this.currentCourseContext?.courseId;
                const errorCourseName = this.coursesData[errorCourseId]?.name || this.currentCourseContext?.courseName;
                
                this.logDetailedError({
                    errorType: 'FILE_EXTRACTION_TIMEOUT',
                    errorMessage: error.message || 'Timeout waiting for page to load',
                    errorStack: error.stack,
                    courseId: errorCourseId,
                    courseName: errorCourseName,
                    scrapingSection: this.currentCourseContext?.scrapingSection || 'file_extraction',
                    url: fileUrl,
                    operation: 'extractFileFromCanvas',
                    completedCourses: this.currentCourseContext?.completedCourses || 0,
                    totalCourses: this.currentCourseContext?.totalCourses || 0,
                    currentPhase: 'file_extraction',
                    additionalContext: {
                        fileUrl: fileUrl,
                        timeoutDuration: '60 seconds',
                        errorCategory: 'TIMEOUT',
                        requiresRestart: true,
                        targetWindowId: this.targetWindowId,
                        fileType: fileUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'unknown'
                    }
                });
                
                console.log(`[SCRAPER-OLD] Triggering restart due to file extraction timeout...`);
                
                // Close all scraping tabs
                await this.closeAllScrapingTabs();
                
                // Set flag to trigger restart
                this.needsRestart = true;
                this.restartInProgress = true; // Signal other operations to stop
                this.restartReason = 'file_extraction_timeout';
                this.restartCourseId = courseId;
                this.restartFileUrl = fileUrl;
                
                // Throw special error to be caught at higher level
                const restartError = new Error('RESTART_REQUIRED: File extraction timeout');
                restartError.isRestartRequired = true;
                throw restartError;
            } else {
                // Log other file extraction errors (non-timeout errors)
                // Python version continues on file errors - don't fail entire scrape
                const errorCourseId = courseId || this.currentCourseContext?.courseId;
                const errorCourseName = this.coursesData[errorCourseId]?.name || this.currentCourseContext?.courseName;
                
                this.logDetailedError({
                    errorType: 'FILE_EXTRACTION_ERROR',
                    errorMessage: error.message || 'Unknown error',
                    errorStack: error.stack,
                    courseId: errorCourseId,
                    courseName: errorCourseName,
                    scrapingSection: this.currentCourseContext?.scrapingSection || 'file_extraction',
                    url: fileUrl,
                    operation: 'extractFileFromCanvas',
                    additionalContext: {
                        fileUrl: fileUrl,
                        errorCategory: 'EXTRACTION_ERROR',
                        isNonFatal: true, // Non-fatal error - continue scraping
                        errorTypeDetail: error.message.includes('Frame') ? 'FRAME_REMOVED' : 
                                       error.message.includes('tab') ? 'TAB_ERROR' : 'OTHER'
                    }
                });
                
                // Return null to continue - don't throw (like Python's continue in except block)
                return null;
            }
        } finally {
            // Restore preserved context
            if (preservedContext) {
                this.currentCourseContext = preservedContext;
            }
        }
    }

    // Log detailed error information
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
            operation: errorContext.operation || null,
            windowId: this.targetWindowId || null,
            activeOperations: Array.from(this.activeOperations.values()),
            scrapingProgress: {
                completedCourses: errorContext.completedCourses || 0,
                totalCourses: errorContext.totalCourses || 0,
                currentPhase: errorContext.currentPhase || null
            },
            courseState: errorContext.courseId ? {
                hasHome: !!(this.coursesData[errorContext.courseId]?.sections?.home),
                hasSyllabus: !!(this.coursesData[errorContext.courseId]?.sections?.syllabus),
                hasModules: !!(this.coursesData[errorContext.courseId]?.sections?.modules),
                hasFiles: !!(this.coursesData[errorContext.courseId]?.sections?.files),
                hasAssignments: !!(this.coursesData[errorContext.courseId]?.sections?.assignments),
                hasAnnouncements: !!(this.coursesData[errorContext.courseId]?.sections?.announcements),
                hasPages: !!(this.coursesData[errorContext.courseId]?.sections?.pages),
                fullyCompleted: !!(this.coursesData[errorContext.courseId]?.fullyCompleted),
                scrapedUrlsCount: this.scrapedUrls ? this.scrapedUrls.size : 0
            } : null,
            browserState: {
                targetWindowId: this.targetWindowId,
                restartInProgress: this.restartInProgress,
                stopRequested: this.stopRequested,
                scrapingInProgress: this.scrapingInProgress
            },
            additionalContext: errorContext.additionalContext || {}
        };
        
        this.errorLog.push(errorLogEntry);
        
        // Format and log detailed error
        const logLines = [
            `\n${'='.repeat(80)}`,
            `[SCRAPER-OLD] DETAILED ERROR LOG`,
            `${'='.repeat(80)}`,
            `Timestamp: ${errorLogEntry.timestamp}`,
            errorLogEntry.elapsedTime ? `Elapsed Time: ${Math.round(errorLogEntry.elapsedTime / 1000)}s` : '',
            `Error Type: ${errorLogEntry.errorType}`,
            `Error Message: ${errorLogEntry.errorMessage}`,
            `\n--- CONTEXT ---`,
            errorLogEntry.courseId ? `Course ID: ${errorLogEntry.courseId}` : '',
            errorLogEntry.courseName ? `Course Name: ${errorLogEntry.courseName}` : '',
            errorLogEntry.scrapingSection ? `Scraping Section: ${errorLogEntry.scrapingSection}` : '',
            errorLogEntry.operation ? `Operation: ${errorLogEntry.operation}` : '',
            errorLogEntry.url ? `URL: ${errorLogEntry.url}` : '',
            `\n--- PROGRESS ---`,
            `Completed: ${errorLogEntry.scrapingProgress.completedCourses}/${errorLogEntry.scrapingProgress.totalCourses} courses`,
            errorLogEntry.scrapingProgress.currentPhase ? `Current Phase: ${errorLogEntry.scrapingProgress.currentPhase}` : '',
            `\n--- COURSE STATE ---`,
            errorLogEntry.courseState ? [
                `  - Home: ${errorLogEntry.courseState.hasHome ? '✓' : '✗'}`,
                `  - Syllabus: ${errorLogEntry.courseState.hasSyllabus ? '✓' : '✗'}`,
                `  - Modules: ${errorLogEntry.courseState.hasModules ? '✓' : '✗'}`,
                `  - Files: ${errorLogEntry.courseState.hasFiles ? '✓' : '✗'}`,
                `  - Assignments: ${errorLogEntry.courseState.hasAssignments ? '✓' : '✗'}`,
                `  - Announcements: ${errorLogEntry.courseState.hasAnnouncements ? '✓' : '✗'}`,
                `  - Pages: ${errorLogEntry.courseState.hasPages ? '✓' : '✗'}`,
                `  - Fully Completed: ${errorLogEntry.courseState.fullyCompleted ? '✓' : '✗'}`,
                `  - Total URLs Scraped: ${errorLogEntry.courseState.scrapedUrlsCount}`
            ].join('\n') : 'N/A',
            `\n--- BROWSER STATE ---`,
            `  - Target Window ID: ${errorLogEntry.browserState.targetWindowId || 'null'}`,
            `  - Restart In Progress: ${errorLogEntry.browserState.restartInProgress}`,
            `  - Stop Requested: ${errorLogEntry.browserState.stopRequested}`,
            `  - Scraping In Progress: ${errorLogEntry.browserState.scrapingInProgress}`,
            `\n--- ACTIVE OPERATIONS ---`,
            errorLogEntry.activeOperations.length > 0 ? errorLogEntry.activeOperations.map(op => `  - ${op}`).join('\n') : 'None',
            errorLogEntry.errorStack ? `\n--- STACK TRACE ---\n${errorLogEntry.errorStack}` : '',
            Object.keys(errorLogEntry.additionalContext).length > 0 ? `\n--- ADDITIONAL CONTEXT ---\n${JSON.stringify(errorLogEntry.additionalContext, null, 2)}` : '',
            `${'='.repeat(80)}\n`
        ].filter(line => line !== '').join('\n');
        
        console.error(logLines);
        
        // Also log to errorLog array summary
        console.error(`[SCRAPER-OLD] Error logged (Total errors: ${this.errorLog.length})`);
        
        return errorLogEntry;
    }

    // Checkpoint: Save progress after completing a section
    checkpointSection(courseId, sectionName) {
        if (!this.coursesData[courseId]) {
            this.coursesData[courseId] = {
                id: courseId,
                name: `Course ${courseId}`,
                sections: {},
                files: [],
                externalLinks: [],
                scrapedAt: Date.now()
            };
        }
        
        // Mark section as completed
        if (!this.coursesData[courseId].sections) {
            this.coursesData[courseId].sections = {};
        }
        
        // Ensure section exists and mark as completed
        if (!this.coursesData[courseId].sections[sectionName]) {
            // Create empty section structure if it doesn't exist
            if (sectionName === 'home' || sectionName === 'syllabus' || sectionName === 'announcements') {
                this.coursesData[courseId].sections[sectionName] = { completed: true };
            } else {
                this.coursesData[courseId].sections[sectionName] = [];
            }
        }
        
        // Mark section as completed
        if (typeof this.coursesData[courseId].sections[sectionName] === 'object' && !Array.isArray(this.coursesData[courseId].sections[sectionName])) {
            this.coursesData[courseId].sections[sectionName].completed = true;
            this.coursesData[courseId].sections[sectionName].completedAt = Date.now();
        } else if (Array.isArray(this.coursesData[courseId].sections[sectionName])) {
            // For array sections, mark the section itself as completed
            this.coursesData[courseId].sections[sectionName]._completed = true;
            this.coursesData[courseId].sections[sectionName]._completedAt = Date.now();
        }
        
        // Update last checkpoint
        this.coursesData[courseId].lastCheckpoint = Date.now();
        this.coursesData[courseId].lastCheckpointSection = sectionName;
        
        // Track completed sections
        if (!this.coursesData[courseId].completedSections) {
            this.coursesData[courseId].completedSections = [];
        }
        if (!this.coursesData[courseId].completedSections.includes(sectionName)) {
            this.coursesData[courseId].completedSections.push(sectionName);
        }
        
        // Log checkpoint
        console.log(`[SCRAPER-OLD]   ✓ Checkpoint: Course ${courseId} section '${sectionName}' completed`);
        
        // Update course completion status
        const expectedSections = ['home', 'syllabus', 'modules', 'files', 'assignments', 'announcements', 'pages'];
        const completedSections = expectedSections.filter(s => {
            const section = this.coursesData[courseId].sections[s];
            if (!section) return false;
            if (Array.isArray(section)) {
                return section._completed === true;
            }
            return section.completed === true;
        });
        
        console.log(`[SCRAPER-OLD]   Progress: Course ${courseId} - ${completedSections.length}/7 sections completed`);
    }

    // Ensure scraping window exists, create if needed
    async ensureScrapingWindow() {
        // Check if current window exists and is valid
        if (this.targetWindowId) {
            try {
                const window = await new Promise((resolve) => {
                    chrome.windows.get(this.targetWindowId, resolve);
                });
                if (window && !chrome.runtime.lastError) {
                    console.log(`[SCRAPER-OLD] Existing scraping window ${this.targetWindowId} is still valid`);
                    return this.targetWindowId;
                }
            } catch (error) {
                console.log(`[SCRAPER-OLD] Window ${this.targetWindowId} no longer exists, creating new one`);
            }
        }
        
        // Create new scraping window
        return new Promise((resolve) => {
            chrome.windows.create({
                url: 'https://canvas.cornell.edu/',
                type: 'normal',
                focused: false,
                width: 800,
                height: 600
            }, (newWindow) => {
                if (chrome.runtime.lastError) {
                    console.error('[SCRAPER-OLD] Error creating scraping window:', chrome.runtime.lastError.message);
                    resolve(null);
                } else {
                    console.log(`[SCRAPER-OLD] Created new scraping window: ${newWindow.id}`);
                    // Mark this window as a scraping window
                    chrome.storage.local.set({
                        [`scrapingWindow_${newWindow.id}`]: true
                    });
                    resolve(newWindow.id);
                }
            });
        });
    }

    // Close all scraping tabs
    async closeAllScrapingTabs() {
        // Close persistent course tabs
        for (const [courseId, tabId] of this.courseTabs.entries()) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (e) {
                // Ignore errors
            }
        }
        this.courseTabs.clear();
        
        // Also close any remaining tabs in the scraping window
        if (this.targetWindowId) {
            try {
                const tabs = await new Promise((resolve) => {
                    chrome.tabs.query({windowId: this.targetWindowId}, resolve);
                });
                console.log(`[SCRAPER-OLD] Closing ${tabs.length} scraping tabs...`);
                for (const tab of tabs) {
                    try {
                        await chrome.tabs.remove(tab.id);
                    } catch (e) {
                        // Ignore errors
                    }
                }
                console.log(`[SCRAPER-OLD] All scraping tabs closed`);
            } catch (e) {
                console.error(`[SCRAPER-OLD] Error closing tabs:`, e);
            }
        }
    }
    
    // Get or create persistent tab for a course (like Python's single driver instance)
    async getOrCreateCourseTab(courseId) {
        // Check if we already have a tab for this course
        if (this.courseTabs.has(courseId)) {
            const existingTabId = this.courseTabs.get(courseId);
            try {
                // Verify tab still exists
                const tab = await new Promise((resolve) => {
                    chrome.tabs.get(existingTabId, resolve);
                });
                if (tab && !chrome.runtime.lastError) {
                    return existingTabId;
                }
            } catch (e) {
                // Tab doesn't exist, remove from map and create new one
                this.courseTabs.delete(courseId);
            }
        }
        
        // Create new persistent tab for this course
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
                console.log(`[SCRAPER-OLD] Created persistent tab ${tab.id} for course ${courseId}`);
                resolve(tab.id);
            });
        });
    }
    
    // Navigate persistent tab to new URL (like Python's driver.get(url))
    async navigateCourseTab(courseId, url) {
        const tabId = await this.getOrCreateCourseTab(courseId);
        
        return new Promise((resolve, reject) => {
            chrome.tabs.update(tabId, { url: url }, (tab) => {
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message;
                    if (errorMsg.includes('No tab with id')) {
                        // Tab was closed, remove from map and try again
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

    // Execute script on a specific page using persistent tab (like Python's driver.get + execute_script)
    async executeScriptOnPage(url, scriptFunc, retries = 0, context = null) {
        // Use provided context or current course context
        const executeContext = context || this.currentCourseContext;
        const courseId = executeContext?.courseId || url.match(/\/courses\/(\d+)/)?.[1];
        
        // Use persistent course tab for ALL pages including files (like Python's single driver)
        // This avoids tab creation/deletion cycles that cause "tab being dragged" errors
        if (courseId) {
            return await this._executeScriptOnPersistentTab(courseId, url, scriptFunc, executeContext);
        } else {
            // Only use temporary tab when courseId is unknown (e.g., dashboard)
            return await this._executeScriptOnTemporaryTab(url, scriptFunc, executeContext);
        }
    }
    
    // Execute script on persistent course tab (like Python's driver.get + execute_script)
    async _executeScriptOnPersistentTab(courseId, url, scriptFunc, context) {
        // Navigate to URL in persistent tab (like driver.get(url))
        let tabId;
        try {
            tabId = await this.navigateCourseTab(courseId, url);
        } catch (error) {
            // If navigation fails, fall back to temporary tab
            console.log(`[SCRAPER-OLD] Failed to navigate persistent tab, using temporary tab: ${error.message}`);
            return await this._executeScriptOnTemporaryTab(url, scriptFunc, context);
        }
        
        // Wait for page to load and execute script
        return new Promise((resolve, reject) => {
            let resolved = false;
            let pageLoaded = false;
            
            const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
                    pageLoaded = true;
                    chrome.tabs.onUpdated.removeListener(listener);
                    
                    // Wait a bit for page to fully render (like Python's time.sleep(2))
                    setTimeout(() => {
                        if (resolved) return;
                        
                        chrome.scripting.executeScript(
                            {
                                target: { tabId: tabId },
                                func: scriptFunc
                            },
                            (results) => {
                                if (chrome.runtime.lastError) {
                                    const errorMsg = chrome.runtime.lastError.message;
                                    // Frame removed errors are non-fatal
                                    if (errorMsg.includes('Frame') || errorMsg.includes('removed')) {
                                        this.logDetailedError({
                                            errorType: 'FRAME_REMOVED_ERROR',
                                            errorMessage: errorMsg,
                                            errorStack: new Error().stack,
                                            url: url,
                                            operation: 'executeScriptOnPersistentTab',
                                            scrapingSection: context?.scrapingSection || 'unknown',
                                            courseId: courseId,
                                            courseName: context?.courseName,
                                            additionalContext: {
                                                tabId: tabId,
                                                errorCategory: 'FRAME_ERROR',
                                                isNonFatal: true
                                            }
                                        });
                                        resolve(null);
                                    } else {
                                        reject(new Error(errorMsg));
                                    }
                                    resolved = true;
                                    return;
                                }
                                
                                if (results && results[0] && results[0].result !== undefined) {
                                    resolve(results[0].result);
                                } else {
                                    resolve(null);
                                }
                                resolved = true;
                            }
                        );
                    }, 2000); // Wait 2s like Python's time.sleep(2)
                }
            };
            
            chrome.tabs.onUpdated.addListener(listener);
            
            // Check if tab is already loaded
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
                    
                    setTimeout(() => {
                        if (resolved) return;
                        
                        chrome.scripting.executeScript(
                            {
                                target: { tabId: tabId },
                                func: scriptFunc
                            },
                            (results) => {
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
                                
                                if (results && results[0] && results[0].result !== undefined) {
                                    resolve(results[0].result);
                                } else {
                                    resolve(null);
                                }
                                resolved = true;
                            }
                        );
                    }, 2000);
                }
            });
            
            // Timeout after 60 seconds
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
    
    // Execute script on temporary tab (for files or special cases)
    async _executeScriptOnTemporaryTab(url, scriptFunc, context) {
        // This is the old method but with better error handling
        return await this._executeScriptOnPageAttempt(url, scriptFunc, 0, context);
    }

    // Single attempt at executing script on page (fallback for temporary tabs)
    // Only used for files or special cases - most pages use persistent tabs
    async _executeScriptOnPageAttempt(url, scriptFunc, attemptNumber, context = null) {
        const executeContext = context || this.currentCourseContext;
        
        return new Promise((resolve, reject) => {
            // Safeguard: Check if window still exists before creating tab
            if (this.targetWindowId) {
                chrome.windows.get(this.targetWindowId, (window) => {
                    if (chrome.runtime.lastError) {
                        // Window doesn't exist - trigger restart
                        const errorMsg = chrome.runtime.lastError.message;
                        this.logDetailedError({
                            errorType: 'WINDOW_NOT_FOUND',
                            errorMessage: errorMsg,
                            errorStack: new Error().stack,
                            url: url,
                            operation: 'executeScriptOnPage (window check)',
                            scrapingSection: executeContext?.scrapingSection || 'unknown',
                            courseId: executeContext?.courseId,
                            courseName: executeContext?.courseName,
                            completedCourses: executeContext?.completedCourses || 0,
                            totalCourses: executeContext?.totalCourses || 0,
                            additionalContext: {
                                targetWindowId: this.targetWindowId,
                                errorCategory: 'BROWSER_STATE_ERROR',
                                requiresRestart: true,
                                chromeError: errorMsg
                            }
                        });
                        
                        const restartError = new Error('RESTART_REQUIRED: Window not found');
                        restartError.isRestartRequired = true;
                        reject(restartError);
                        return;
                    }
                    
                    // Window exists, proceed with temporary tab creation (for files only)
                    this._createTabAndExecute(url, scriptFunc, resolve, reject, executeContext);
                });
            } else {
                // No window ID specified, create tab in current window
                this._createTabAndExecute(url, scriptFunc, resolve, reject, executeContext);
            }
        });
    }
    
    // Helper: Create temporary tab and execute script (only for files/special cases)
    // Most pages should use persistent tabs via _executeScriptOnPersistentTab
    _createTabAndExecute(url, scriptFunc, resolve, reject, context) {
        const createTabOptions = { url: url, active: false };
        if (this.targetWindowId) {
            createTabOptions.windowId = this.targetWindowId;
        }

        chrome.tabs.create(createTabOptions, (tab) => {
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message;
                    // Check if this is a window/tab error that should trigger restart
                    if (errorMsg.includes('No window with id') || errorMsg.includes('No tab with id')) {
                        // Log detailed error with context
                        this.logDetailedError({
                            errorType: 'WINDOW_TAB_ERROR',
                            errorMessage: errorMsg,
                            errorStack: new Error().stack,
                            url: url,
                            operation: 'executeScriptOnPage (create tab)',
                            scrapingSection: context?.scrapingSection || 'page_execution',
                            courseId: context?.courseId,
                            courseName: context?.courseName,
                            completedCourses: context?.completedCourses || 0,
                            totalCourses: context?.totalCourses || 0,
                            additionalContext: {
                                targetWindowId: this.targetWindowId,
                                errorCategory: 'BROWSER_STATE_ERROR',
                                requiresRestart: true,
                                chromeError: errorMsg
                            }
                        });
                        
                        const restartError = new Error('RESTART_REQUIRED: Window/tab error');
                        restartError.isRestartRequired = true;
                        reject(restartError);
                    } else {
                        this.logDetailedError({
                            errorType: 'TAB_CREATION_ERROR',
                            errorMessage: errorMsg,
                            errorStack: new Error().stack,
                            url: url,
                            operation: 'executeScriptOnPage (create tab)',
                            scrapingSection: context?.scrapingSection || 'unknown',
                            courseId: context?.courseId,
                            courseName: context?.courseName,
                            additionalContext: {
                                targetWindowId: this.targetWindowId,
                                errorCategory: 'TAB_CREATION_ERROR',
                                chromeError: errorMsg
                            }
                        });
                        reject(new Error(`Failed to create tab: ${errorMsg}`));
                    }
                    return;
                }

                const tabId = tab.id;
                let resolved = false;
                let pageLoaded = false;

                const listener = (updatedTabId, changeInfo) => {
                    if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
                        pageLoaded = true;
                        chrome.tabs.onUpdated.removeListener(listener);
                        
                        setTimeout(() => {
                            if (resolved) return;

                            chrome.scripting.executeScript(
                                {
                                    target: { tabId: tabId },
                                    func: scriptFunc
                                },
                                  (results) => {
                                      // Don't remove tab - it's a temporary tab that will be cleaned up later
                                      // Only remove if it's not a persistent course tab
                                      // (This method is only used for dashboard/unknown URLs now)
                                      // Clean up temporary tab after a delay to avoid rapid create/remove cycles
                                      setTimeout(() => {
                                          chrome.tabs.remove(tabId).catch(() => {});
                                      }, 1000);

                                      if (chrome.runtime.lastError) {
                                          const errorMsg = chrome.runtime.lastError.message;
                                          
                                          // Handle different Chrome API errors
                                          if (errorMsg.includes('tab') && errorMsg.includes('edit')) {
                                              reject(new Error('TAB_EDITING_BLOCKED'));
                                              resolved = true;
                                              return;
                                          }
                                          
                                          // Frame removed errors - common when tabs are closed mid-operation
                                          if (errorMsg.includes('Frame') || errorMsg.includes('removed')) {
                                              // Log but don't trigger restart for frame errors (non-fatal)
                                              this.logDetailedError({
                                                  errorType: 'FRAME_REMOVED_ERROR',
                                                  errorMessage: errorMsg,
                                                  errorStack: new Error().stack,
                                                  url: url,
                                                  operation: 'executeScriptOnPage (script execution)',
                                                  scrapingSection: this.currentCourseContext?.scrapingSection || 'unknown',
                                                  courseId: this.currentCourseContext?.courseId,
                                                  courseName: this.currentCourseContext?.courseName,
                                                  additionalContext: {
                                                      tabId: tabId,
                                                      targetWindowId: this.targetWindowId,
                                                      errorCategory: 'FRAME_ERROR',
                                                      isNonFatal: true,
                                                      chromeError: errorMsg
                                                  }
                                              });
                                              
                                              // Return null result instead of throwing (like Python's continue)
                                              resolve(null);
                                              resolved = true;
                                              return;
                                          }
                                          
                                          reject(new Error(errorMsg));
                                          resolved = true;
                                          return;
                                      }

                                    if (results && results[0] && results[0].result !== undefined) {
                                        resolve(results[0].result);
                                    } else {
                                        resolve(null);
                                    }
                                    resolved = true;
                                }
                            );
                        }, 1000);
                    }
                };

                chrome.tabs.onUpdated.addListener(listener);

                const timeout = setTimeout(() => {
                    if (!resolved) {
                        chrome.tabs.onUpdated.removeListener(listener);
                        chrome.tabs.remove(tabId).catch(() => {});
                        
                        // Log detailed timeout error with better context
                        // Try to extract course context from URL if currentCourseContext is not set
                        const courseIdFromUrl = url.match(/\/courses\/(\d+)/)?.[1];
                        
                        this.logDetailedError({
                            errorType: 'PAGE_LOAD_TIMEOUT',
                            errorMessage: `Timeout waiting for page to load: ${url}`,
                            errorStack: new Error().stack,
                            url: url,
                            operation: 'executeScriptOnPage (timeout)',
                            scrapingSection: this.currentCourseContext?.scrapingSection || (url.includes('/files/') ? 'file_extraction' : 'page_execution'),
                            courseId: this.currentCourseContext?.courseId || courseIdFromUrl,
                            courseName: this.currentCourseContext?.courseName || (courseIdFromUrl ? this.coursesData[courseIdFromUrl]?.name : null),
                            completedCourses: this.currentCourseContext?.completedCourses || 0,
                            totalCourses: this.currentCourseContext?.totalCourses || 0,
                            additionalContext: {
                                timeoutDuration: '60 seconds',
                                tabId: tabId,
                                targetWindowId: this.targetWindowId,
                                errorCategory: 'TIMEOUT',
                                requiresRestart: url.includes('/files/') || url.includes('/download'),
                                isFileUrl: url.includes('/files/'),
                                isDownloadUrl: url.includes('/download')
                            }
                        });
                        
                        // Only trigger restart for file extraction timeouts (like Python scraper continues on other errors)
                        const timeoutError = new Error(`Timeout waiting for page to load: ${url}`);
                        // File extraction timeouts are critical and require restart
                        if (url.includes('/files/') || url.includes('/download')) {
                            timeoutError.isRestartRequired = true;
                        }
                        // For non-file URLs, just log and reject (don't trigger restart)
                        reject(timeoutError);
                        resolved = true;
                    }
                }, 60000);

                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError) {
                        clearTimeout(timeout);
                        chrome.tabs.onUpdated.removeListener(listener);
                        const errorMsg = chrome.runtime.lastError.message;
                        // Check if this is a window/tab error that should trigger restart
                        if (errorMsg.includes('No window with id') || errorMsg.includes('No tab with id')) {
                            // Log detailed error with context
                            const getTabContext = context || this.currentCourseContext;
                            this.logDetailedError({
                                errorType: 'WINDOW_TAB_ERROR',
                                errorMessage: errorMsg,
                                errorStack: new Error().stack,
                                url: url,
                                operation: 'executeScriptOnPage (get tab)',
                                scrapingSection: getTabContext?.scrapingSection || 'page_execution',
                                courseId: getTabContext?.courseId,
                                courseName: getTabContext?.courseName,
                                completedCourses: getTabContext?.completedCourses || 0,
                                totalCourses: getTabContext?.totalCourses || 0,
                                additionalContext: {
                                    targetWindowId: this.targetWindowId,
                                    tabId: tabId,
                                    errorCategory: 'BROWSER_STATE_ERROR',
                                    requiresRestart: true,
                                    chromeError: errorMsg
                                }
                            });
                            
                            const restartError = new Error('RESTART_REQUIRED: Window/tab error');
                            restartError.isRestartRequired = true;
                            reject(restartError);
                        } else {
                            const accessContext = context || this.currentCourseContext;
                            this.logDetailedError({
                                errorType: 'TAB_ACCESS_ERROR',
                                errorMessage: errorMsg,
                                errorStack: new Error().stack,
                                url: url,
                                operation: 'executeScriptOnPage (get tab)',
                                scrapingSection: accessContext?.scrapingSection || 'unknown',
                                courseId: accessContext?.courseId,
                                courseName: accessContext?.courseName,
                                additionalContext: {
                                    targetWindowId: this.targetWindowId,
                                    tabId: tabId,
                                    errorCategory: 'TAB_ACCESS_ERROR',
                                    chromeError: errorMsg
                                }
                            });
                            reject(new Error(`Failed to get tab: ${errorMsg}`));
                        }
                        resolved = true;
                        return;
                    }

                    if (tab.status === 'complete' && !resolved && !pageLoaded) {
                        chrome.tabs.onUpdated.removeListener(listener);
                        pageLoaded = true;
                        
                        setTimeout(() => {
                            if (resolved) return;
                            
                            chrome.scripting.executeScript(
                                {
                                    target: { tabId: tabId },
                                    func: scriptFunc
                                },
                                (results) => {
                                    clearTimeout(timeout);
                                    // Don't remove tab immediately - delay cleanup
                                    setTimeout(() => {
                                        chrome.tabs.remove(tabId).catch(() => {});
                                    }, 1000);

                                    if (chrome.runtime.lastError) {
                                        const errorMsg = chrome.runtime.lastError.message;
                                        if (errorMsg.includes('tab') && errorMsg.includes('edit')) {
                                            reject(new Error('TAB_EDITING_BLOCKED'));
                                            resolved = true;
                                            return;
                                        }
                                        reject(new Error(errorMsg));
                                        resolved = true;
                                        return;
                                    }

                                    if (results && results[0] && results[0].result !== undefined) {
                                        resolve(results[0].result);
                                    } else {
                                        resolve(null);
                                    }
                                    resolved = true;
                                }
                            );
                        }, 1000);
                    }
                });
        }); // Close chrome.tabs.create callback
    }

    // Sleep helper
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Send progress update
    sendProgress(message) {
        if (this.progressCallback) {
            this.progressCallback(message);
        }
        console.log(`[SCRAPER-OLD] ${message}`);
    }

    // Save scraped data to storage
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

    // Get scraped data from storage
    async getScrapedData() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['scrapedCanvasData'], (result) => {
                resolve(result.scrapedCanvasData || null);
            });
        });
    }

    // Clear scraped data
    async clearScrapedData() {
        this.coursesData = {};
        this.scrapedUrls = new Set();
        try {
            await chrome.storage.local.remove(['scrapedCanvasData']);
            console.log('[SCRAPER-OLD] Cleared scraped data');
        } catch (error) {
            console.error('[SCRAPER-OLD] Error clearing scraped data:', error);
        }
    }

    // Remove HTML from corpus
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
            if (course.sections) {
                for (const sectionName in course.sections) {
                    const section = course.sections[sectionName];
                    
                    if (section.content) {
                        section.content = processContent(section.content);
                    }
                    
                    if (section.files && Array.isArray(section.files)) {
                        for (const file of section.files) {
                            if (file.content) {
                                file.content = processContent(file.content);
                            }
                        }
                    }
                    
                    if (Array.isArray(section)) {
                        for (const item of section) {
                            if (item.content) {
                                item.content = processContent(item.content);
                            }
                            if (item.items && Array.isArray(item.items)) {
                                for (const subItem of item.items) {
                                    if (subItem.content) {
                                        subItem.content = processContent(subItem.content);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Format corpus for GPT
    formatCorpusForGPT() {
        let corpus = '';
        for (const courseId in this.coursesData) {
            const course = this.coursesData[courseId];
            corpus += `\n\n=== COURSE: ${course.name || courseId} ===\n\n`;
            
            if (course.sections) {
                if (course.sections.home && course.sections.home.content) {
                    corpus += `--- Home Page ---\n${course.sections.home.content}\n\n`;
                }
                if (course.sections.syllabus && course.sections.syllabus.content) {
                    corpus += `--- Syllabus ---\n${course.sections.syllabus.content}\n\n`;
                    if (course.sections.syllabus.files) {
                        for (const file of course.sections.syllabus.files) {
                            corpus += `--- Syllabus File: ${file.name} ---\n${file.content || ''}\n\n`;
                        }
                    }
                }
                if (course.sections.modules) {
                    for (const module of course.sections.modules) {
                        corpus += `--- Module: ${module.name} ---\n`;
                        if (module.items) {
                            for (const item of module.items) {
                                if (item.content) {
                                    corpus += `${item.name}: ${item.content}\n\n`;
                                }
                            }
                        }
                    }
                }
                if (course.sections.files) {
                    for (const file of course.sections.files) {
                        corpus += `--- File: ${file.name} ---\n${file.content || ''}\n\n`;
                    }
                }
                if (course.sections.assignments) {
                    for (const assign of course.sections.assignments) {
                        corpus += `--- Assignment: ${assign.name} ---\n${assign.content || ''}\n\n`;
                    }
                }
                if (course.sections.announcements && course.sections.announcements.content) {
                    corpus += `--- Announcements ---\n${course.sections.announcements.content}\n\n`;
                }
                if (course.sections.pages) {
                    for (const page of course.sections.pages) {
                        corpus += `--- Page: ${page.name} ---\n${page.content || ''}\n\n`;
                    }
                }
            }
        }
        return corpus;
    }

    // Process single batch with GPT
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
1. COMPLETE syllabus information:
   - Every policy, rule, and guideline
   - Course schedule and calendar
   - Instructor information and contact details
   - Learning objectives and outcomes
   - All syllabus sections in full

2. ALL assignments and problem sets (PSETS):
   - Assignment/PSET names and full descriptions
   - Complete instructions and requirements
   - Due dates (preserve exact dates and times)
   - Points/points possible/grading criteria
   - Submission details and requirements
   - Any attached files or resources mentioned

3. ALL exam information:
   - Exam names and dates (preserve exact dates and times)
   - Exam formats and structure
   - Topics covered
   - Exam locations if mentioned
   - Study guides or preparation materials

4. ALL readings:
   - Reading titles and authors
   - Reading assignments with dates
   - Summaries of reading content (at minimum, key points)
   - Reading notes or discussion questions if present

5. ALL lecture information:
   - Lecture topics and titles
   - Lecture dates and schedule
   - Lecture notes or summaries (at minimum, key points)
   - Slide decks or presentation materials mentioned

6. ALL notes and supplementary materials:
   - Class notes (at minimum, summarized key points)
   - Study guides
   - Handouts
   - Any additional course materials

7. ALL dates for everything:
   - Assignment due dates
   - Exam dates
   - Quiz dates
   - Discussion deadlines
   - Reading deadlines
   - Project deadlines
   - Any other important dates

8. Grade information:
   - Grade breakdown and percentages
   - Grading policies
   - Late work policies
   - Extra credit opportunities
   - Grade scales

9. Course policies:
   - Attendance policies
   - Late work policies
   - Academic integrity policies
   - Communication policies
   - Any other course-specific policies

OUTPUT FORMAT: Output clean, readable text organized by course. Group all content for each course together.

OUTPUT LENGTH: Target approximately 480,000 characters (120,000 tokens) per batch. Include as much information as possible. If input is smaller, output everything. If larger, prioritize comprehensive coverage - do NOT truncate important information.

CLEANING RULES:
1. Remove all HTML tags, attributes, and artifacts completely
2. Remove broken formatting and spacing issues
3. Fix encoding issues and character artifacts
4. Clean up repeated whitespace and line breaks
5. Preserve all actual content - dates, numbers, text, names
6. Maintain readability with proper paragraph breaks
7. Preserve dates in their original format (do not convert unless format is unclear)
8. Keep all numbers, point values, percentages exactly as they appear

ORGANIZATION RULES:
1. Group ALL content by course name/number
2. Within each course, organize by:
   - Syllabus (complete)
   - Assignments/PSETS (with dates and full details)
   - Exams (with dates and details)
   - Readings (with summaries)
   - Lectures (with summaries)
   - Notes (with summaries)
   - Schedules and calendars
   - Policies
   - Other materials
3. If the same information appears multiple times, deduplicate but keep the most complete version
4. Preserve all dates exactly as found
5. Do NOT omit any substantive content

OUTPUT FORMAT (plain text organized by course):

=== COURSE: [Course Name/Code] ===

--- SYLLABUS ---
[Complete syllabus content, cleaned of HTML artifacts]

--- ASSIGNMENTS / PSETS ---
[All assignments with names, descriptions, due dates, points, instructions - cleaned]

--- EXAMS ---
[All exam information with dates, formats, topics - cleaned]

--- READINGS ---
[All readings with titles, dates, summaries/key points - cleaned]

--- LECTURES ---
[All lecture information with dates, topics, summaries/key points - cleaned]

--- NOTES ---
[All notes with summaries/key points - cleaned]

--- SCHEDULE / CALENDAR ---
[Course schedule and calendar - cleaned]

--- POLICIES ---
[All course policies - cleaned]

--- OTHER MATERIALS ---
[Any other course materials - cleaned]

=== END COURSE: [Course Name/Code] ===

[Repeat for each course]

If the input is empty or contains no useful information, output: "No course content found."

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
                    { role: 'system', content: 'You are an educational content cleaning assistant. Your job is to remove HTML scraping artifacts from Canvas LMS content and organize it by course. You MUST preserve ALL syllabus information, ALL assignments/PSETS with dates, ALL exams with dates, ALL readings (with summaries), ALL lectures (with summaries), ALL notes (with summaries), ALL dates, grades, and policies. Output clean, readable text organized by course. Target ~480,000 characters per batch. Do NOT omit any substantive content.' },
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

    // Restructure corpus with GPT (stores compressed context, NO RAG indexing)
    async restructureCorpusWithGPT() {
        const corpus = this.formatCorpusForGPT();
        
        if (!corpus || corpus.trim().length === 0) {
            console.log('[SCRAPER-OLD] No corpus to restructure');
            return;
        }

        // Count characters and calculate batches
        const charCount = corpus.length;
        const charsPerBatch = 400000 * 4; // 400,000 tokens * 4 chars per token
        const numBatches = Math.ceil(charCount / charsPerBatch) || 1;

        console.log(`[SCRAPER-OLD] Corpus size: ${charCount} chars, splitting into ${numBatches} batch(es)`);
        this.sendProgress(`Restructuring corpus (${numBatches} batch${numBatches > 1 ? 'es' : ''})...`);

        const batches = [];
        for (let i = 0; i < numBatches; i++) {
            const start = i * charsPerBatch;
            const end = Math.min(start + charsPerBatch, charCount);
            batches.push(corpus.substring(start, end));
        }

        // Process each batch
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
                restructuredBatches.push(batches[i]); // Use original if GPT fails
            }
        }

        // Combine all batches into compressed context
        const compressedContext = restructuredBatches.join('\n\n');
        
        // Store compressed context in coursesData (will be passed directly to GPT-5-nano for chat)
        for (const courseId in this.coursesData) {
            this.coursesData[courseId].compressedContext = compressedContext;
        }

        // Also store globally for easy access
        this.coursesData._compressedContext = compressedContext;

        console.log(`[SCRAPER-OLD] Compressed context created (${compressedContext.length} chars) - ready to pass to GPT-5-nano for chat`);
    }

    // Keep computer awake during scraping
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
}
