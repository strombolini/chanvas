// Core Scraping Engine for Canvas

class CanvasScraper {
  constructor() {
    this.isActive = false;
    this.isPaused = false;
    this.visitedURLs = new Set();
    this.linkQueue = [];
    this.currentCourse = null;
    this.stats = {
      coursesTotal: 0,
      coursesScraped: 0,
      pagesScraped: 0,
      filesScraped: 0,
      pdfsScraped: 0
    };
    this.pdfExtractor = new PDFExtractor();
    this.scrapedData = {};
  }
  
  // Main entry point - start scraping
  async start() {
    if (this.isActive) {
      log('Scraper is already running');
      return;
    }
    
    this.isActive = true;
    this.isPaused = false;
    log('🚀 Starting Canvas scraper...');
    updateActivity('Initializing scraper...');
    
    try {
      // Load previous state if exists
      await this.loadState();
      
      // Check if we're on Canvas
      if (!window.location.href.includes('canvas.cornell.edu')) {
        throw new Error('Not on Canvas website');
      }
      
      // Start scraping process
      await this.scrapeAll();
      
      log('🎉 Scraping complete!');
      updateActivity('Scraping complete!');
      chrome.runtime.sendMessage({ type: 'scraping_complete' });
      
    } catch (error) {
      log('❌ Error during scraping: ' + error.message);
      chrome.runtime.sendMessage({ 
        type: 'error', 
        error: error.message 
      });
    } finally {
      this.isActive = false;
      await this.saveState();
    }
  }
  
  // Stop scraping
  stop() {
    log('⏸️ Stopping scraper...');
    this.isActive = false;
    this.isPaused = true;
    updateActivity('Scraper stopped');
  }
  
  // Resume scraping
  async resume() {
    if (this.isActive) {
      log('Scraper is already running');
      return;
    }
    
    log('▶️ Resuming scraper...');
    this.isPaused = false;
    await this.start();
  }
  
  // Main scraping workflow
  async scrapeAll() {
    // Step 1: Navigate to dashboard if not already there
    if (!window.location.href.includes('/dashboard') && 
        !window.location.href.endsWith('canvas.cornell.edu/')) {
      log('Navigating to dashboard...');
      window.location.href = 'https://canvas.cornell.edu/';
      await waitForLoad();
      await sleep(2000);
    }
    
    // Step 2: Get all courses
    log('📚 Discovering courses...');
    updateActivity('Discovering courses...');
    const courses = await this.getAllCourses();
    this.stats.coursesTotal = courses.length;
    log(`Found ${courses.length} courses`);
    updateProgress(this.stats);
    
    // Step 3: Scrape each course
    for (let i = 0; i < courses.length; i++) {
      if (!this.isActive) {
        log('Scraper stopped by user');
        break;
      }
      
      const course = courses[i];
      this.currentCourse = course;
      
      log(`\n${'='.repeat(50)}`);
      log(`📖 Course ${i + 1}/${courses.length}: ${course.name}`);
      log('='.repeat(50));
      updateActivity(`Scraping course ${i + 1}/${courses.length}: ${course.name}`);
      
      await this.scrapeCourse(course);
      
      this.stats.coursesScraped++;
      updateProgress(this.stats);
      
      // Save progress after each course
      await this.saveState();
      await this.saveScrapedData();
    }
    
    log('\n✅ All courses scraped!');
  }
  
  // Get all courses from dashboard
  async getAllCourses() {
    const courses = [];
    
    // Wait for course cards to load
    await sleep(2000);
    
    // Find course cards
    const courseSelectors = [
      'a[href*="/courses/"]',
      '[class*="course-card"] a',
      '[class*="ic-DashboardCard"] a'
    ];
    
    const courseLinks = new Set();
    
    for (const selector of courseSelectors) {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.href;
        if (href && href.includes('/courses/') && !href.includes('/courses?')) {
          courseLinks.add(href);
        }
      }
    }
    
    // Extract course info
    for (const url of courseLinks) {
      const courseId = extractCourseId(url);
      if (!courseId) continue;
      
      // Try to find course name
      let name = 'Unknown Course';
      const courseCard = document.querySelector(`a[href*="/courses/${courseId}"]`);
      if (courseCard) {
        // Look for course name in card
        const nameElement = courseCard.querySelector('h2, h3, [class*="name"], [class*="title"]');
        if (nameElement) {
          name = nameElement.textContent.trim();
        } else {
          name = courseCard.textContent.trim().split('\n')[0];
        }
      }
      
      courses.push({
        id: courseId,
        name: name,
        url: url.split('?')[0] // Remove query params
      });
    }
    
    return courses;
  }
  
  // Scrape a single course
  async scrapeCourse(course) {
    // Initialize course data
    this.scrapedData[course.id] = {
      id: course.id,
      name: course.name,
      url: course.url,
      tabs: {},
      scrapedAt: formatTimestamp()
    };
    
    // Navigate to course home
    log(`Navigating to course: ${course.url}`);
    if (window.location.href !== course.url) {
      window.location.href = course.url;
      await waitForLoad();
      await sleep(2000);
    }
    
    // Get all navigation tabs
    const tabs = await this.getCourseTabs();
    log(`Found ${tabs.length} tabs in course`);
    
    // Scrape each tab
    for (const tab of tabs) {
      if (!this.isActive) break;
      
      log(`\n  📑 Scraping tab: ${tab.name}`);
      updateActivity(`Scraping ${course.name} - ${tab.name}`);
      
      await this.scrapeTab(course, tab);
      
      // Small delay between tabs
      await sleep(1000);
    }
    
    // Process any queued links from this course
    await this.processLinkQueue(course);
  }
  
  // Get all tabs in a course
  async getCourseTabs() {
    const tabs = [];
    
    // Find navigation menu
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
        
        // Skip external services
        if (isExternalService(href)) {
          log(`  ⏭️  Skipping external service: ${text}`);
          continue;
        }
        
        // Skip if not a Canvas URL
        if (!isCanvasURL(href)) continue;
        
        // Skip if already visited
        const normalizedURL = normalizeURL(href);
        if (this.visitedURLs.has(normalizedURL)) continue;
        
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
  }
  
  // Scrape a single tab
  async scrapeTab(course, tab) {
    const tabKey = sanitizeFilename(tab.name.toLowerCase().replace(/\s+/g, '_'));
    
    // Navigate to tab
    if (window.location.href !== tab.url) {
      window.location.href = tab.url;
      await waitForLoad();
      await sleep(1500);
    }
    
    // Mark as visited
    this.visitedURLs.add(tab.url);
    
    // Expand all collapsible content
    await this.expandAllContent();
    
    // Scroll all containers
    await this.scrollAllContainers();
    
    // Check if this is a PDF viewer
    if (this.pdfExtractor.isPDFViewerPage()) {
      log('    📄 PDF detected, extracting...');
      const pdfData = await this.pdfExtractor.extractFullPDF();
      if (pdfData) {
        this.scrapedData[course.id].tabs[tabKey] = pdfData;
        this.stats.pdfsScraped++;
        this.stats.filesScraped++;
        updateProgress(this.stats);
        return;
      }
    }
    
    // Extract page content
    const content = await this.extractPageContent();
    this.scrapedData[course.id].tabs[tabKey] = content;
    this.stats.pagesScraped++;
    updateProgress(this.stats);
    
    // Extract all links and add to queue
    const links = getAllLinks();
    for (const link of links) {
      if (!this.visitedURLs.has(link.url)) {
        this.linkQueue.push({
          url: link.url,
          courseId: course.id,
          context: link.context
        });
      }
    }
    
    log(`    ✅ Scraped ${tab.name} (${content.text.length} chars, ${links.length} links found)`);
  }
  
  // Expand all collapsible/expandable content
  async expandAllContent() {
    log('    🔽 Expanding all content...');
    
    // Click "Expand All" buttons
    const expandAllButtons = document.querySelectorAll(
      'button:contains("Expand All"), ' +
      'button[aria-label*="expand all" i], ' +
      'button[class*="expand-all" i], ' +
      '.expand-collapse-all'
    );
    
    for (const button of expandAllButtons) {
      if (isElementVisible(button)) {
        clickElement(button);
        await sleep(500);
      }
    }
    
    // Expand individual collapsible items
    const collapsibleSelectors = [
      '[aria-expanded="false"]',
      'details:not([open])',
      '[class*="collapsed"]',
      '.collapsible:not(.expanded)'
    ];
    
    for (const selector of collapsibleSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (!isElementVisible(element)) continue;
        
        if (element.tagName === 'DETAILS') {
          element.open = true;
        } else if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') {
          clickElement(element);
        } else {
          // Try clicking the element
          clickElement(element);
        }
        
        await sleep(200);
      }
    }
    
    // Wait for expansions to complete
    await sleep(1000);
    await waitForNetworkIdle(1000);
  }
  
  // Scroll all scrollable containers
  async scrollAllContainers() {
    log('    📜 Scrolling all containers...');
    
    const scrollable = findScrollableElements();
    log(`    Found ${scrollable.length} scrollable containers`);
    
    for (let i = 0; i < scrollable.length; i++) {
      const item = scrollable[i];
      
      // Skip very small containers (likely UI elements)
      if (item.clientHeight < 100) continue;
      
      log(`    Scrolling container ${i + 1}/${scrollable.length} (${item.scrollHeight}px)`);
      
      try {
        await scrollToBottom(item.element, {
          stepSize: 0.7,
          delay: 400,
          direction: 'vertical'
        });
      } catch (e) {
        log(`    ⚠️  Failed to scroll container: ${e.message}`);
      }
    }
    
    // Also scroll the main window
    if (document.documentElement.scrollHeight > window.innerHeight) {
      log('    Scrolling main window...');
      await scrollToBottom(document.documentElement, {
        stepSize: 0.8,
        delay: 300
      });
    }
    
    // Wait for any lazy-loaded content
    await sleep(1000);
    await waitForNetworkIdle(1000);
  }
  
  // Extract content from current page
  async extractPageContent() {
    const content = {
      url: getCurrentURL(),
      title: getPageTitle(),
      timestamp: formatTimestamp(),
      text: '',
      html: '',
      links: [],
      metadata: {}
    };
    
    // Extract main content area
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
    
    // Extract text with structure
    content.text = extractTextWithStructure(mainContent);
    
    // Extract HTML (cleaned)
    const cleanedContent = mainContent.cloneNode(true);
    cleanedContent.querySelectorAll('script, style, noscript, nav, header, footer').forEach(el => el.remove());
    content.html = cleanedContent.innerHTML;
    
    // Extract links
    content.links = getAllLinks();
    
    // Extract metadata
    content.metadata = this.extractMetadata();
    
    return content;
  }
  
  // Extract metadata from page
  extractMetadata() {
    const metadata = {};
    
    // Get meta tags
    const metaTags = document.querySelectorAll('meta');
    for (const meta of metaTags) {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (name && content) {
        metadata[name] = content;
      }
    }
    
    // Get course info if available
    const courseIdMatch = window.location.pathname.match(/\/courses\/(\d+)/);
    if (courseIdMatch) {
      metadata.courseId = courseIdMatch[1];
    }
    
    // Get breadcrumb
    const breadcrumbs = document.querySelectorAll('[class*="breadcrumb"] a, nav a');
    if (breadcrumbs.length > 0) {
      metadata.breadcrumb = Array.from(breadcrumbs).map(a => a.textContent.trim());
    }
    
    return metadata;
  }
  
  // Process queued links recursively
  async processLinkQueue(course) {
    log(`\n  🔗 Processing ${this.linkQueue.length} queued links...`);
    
    // Filter links for this course
    const courseLinks = this.linkQueue.filter(item => item.courseId === course.id);
    
    // Remove processed links from queue
    this.linkQueue = this.linkQueue.filter(item => item.courseId !== course.id);
    
    let processed = 0;
    const maxLinks = 100; // Limit to prevent infinite loops
    
    for (const linkItem of courseLinks) {
      if (!this.isActive) break;
      if (processed >= maxLinks) {
        log(`  ⚠️  Reached max link limit (${maxLinks}), stopping`);
        break;
      }
      
      // Skip if already visited
      if (this.visitedURLs.has(linkItem.url)) continue;
      
      log(`  📎 Following link: ${linkItem.url}`);
      updateActivity(`Following link in ${course.name}...`);
      
      try {
        await this.scrapePage(course, linkItem);
        processed++;
      } catch (e) {
        log(`  ❌ Failed to scrape link: ${e.message}`);
      }
      
      // Small delay between links
      await sleep(800);
    }
    
    log(`  ✅ Processed ${processed} links`);
  }
  
  // Scrape a single page/link
  async scrapePage(course, linkItem) {
    // Navigate to page
    if (window.location.href !== linkItem.url) {
      window.location.href = linkItem.url;
      await waitForLoad();
      await sleep(1500);
    }
    
    // Mark as visited
    this.visitedURLs.add(linkItem.url);
    
    // Expand and scroll
    await this.expandAllContent();
    await this.scrollAllContainers();
    
    // Check if PDF
    if (this.pdfExtractor.isPDFViewerPage()) {
      const pdfData = await this.pdfExtractor.extractFullPDF();
      if (pdfData) {
        const key = `file_${extractFileId(linkItem.url) || generateId()}`;
        this.scrapedData[course.id][key] = pdfData;
        this.stats.pdfsScraped++;
        this.stats.filesScraped++;
        updateProgress(this.stats);
        return;
      }
    }
    
    // Extract content
    const content = await this.extractPageContent();
    const pageKey = `page_${generateId()}`;
    this.scrapedData[course.id][pageKey] = {
      ...content,
      context: linkItem.context
    };
    
    this.stats.pagesScraped++;
    updateProgress(this.stats);
    
    // Extract new links (but don't process them to avoid infinite recursion)
    const newLinks = getAllLinks();
    log(`    Found ${newLinks.length} more links (not following to prevent loops)`);
  }
  
  // Save scraped data to storage
  async saveScrapedData() {
    log('💾 Saving scraped data...');
    
    for (const [courseId, courseData] of Object.entries(this.scrapedData)) {
      const key = `course_${courseId}`;
      await chrome.storage.local.set({ [key]: courseData });
    }
    
    log('✅ Data saved');
  }
  
  // Save scraper state
  async saveState() {
    const state = {
      active: this.isActive,
      paused: this.isPaused,
      visitedURLs: Array.from(this.visitedURLs),
      linkQueue: this.linkQueue,
      currentCourse: this.currentCourse,
      stats: this.stats,
      timestamp: Date.now()
    };
    
    await chrome.storage.local.set({ 
      scraper_state: state,
      scraper_stats: this.stats
    });
  }
  
  // Load scraper state
  async loadState() {
    const result = await chrome.storage.local.get(['scraper_state', 'scraper_stats']);
    
    if (result.scraper_state) {
      const state = result.scraper_state;
      this.visitedURLs = new Set(state.visitedURLs || []);
      this.linkQueue = state.linkQueue || [];
      this.currentCourse = state.currentCourse;
      log(`Loaded state: ${this.visitedURLs.size} visited URLs, ${this.linkQueue.length} queued links`);
    }
    
    if (result.scraper_stats) {
      this.stats = result.scraper_stats;
      updateProgress(this.stats);
    }
  }
  
  // Clear all data
  async clearAll() {
    this.visitedURLs.clear();
    this.linkQueue = [];
    this.scrapedData = {};
    this.stats = {
      coursesTotal: 0,
      coursesScraped: 0,
      pagesScraped: 0,
      filesScraped: 0,
      pdfsScraped: 0
    };
    
    await chrome.storage.local.clear();
    log('🗑️ All data cleared');
  }
}

// Create global scraper instance
let canvasScraper = null;

// Initialize scraper when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    canvasScraper = new CanvasScraper();
  });
} else {
  canvasScraper = new CanvasScraper();
}
