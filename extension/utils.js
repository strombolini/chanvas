// Utility Functions for Canvas Scraper

// Sleep/delay function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wait for element to appear
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }
    
    const observer = new MutationObserver((mutations, obs) => {
      const element = document.querySelector(selector);
      if (element) {
        obs.disconnect();
        resolve(element);
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element ${selector} not found within ${timeout}ms`));
    }, timeout);
  });
}

// Wait for page to fully load
function waitForLoad() {
  return new Promise((resolve) => {
    if (document.readyState === 'complete') {
      resolve();
    } else {
      window.addEventListener('load', resolve);
    }
  });
}

// Wait for network to be idle
function waitForNetworkIdle(timeout = 2000) {
  return new Promise((resolve) => {
    let timer;
    const observer = new PerformanceObserver((list) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeout);
    });
    
    try {
      observer.observe({ entryTypes: ['resource'] });
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeout);
    } catch (e) {
      // Fallback if PerformanceObserver not supported
      setTimeout(resolve, timeout);
    }
  });
}

// Extract course ID from URL
function extractCourseId(url) {
  const match = url.match(/\/courses\/(\d+)/);
  return match ? match[1] : null;
}

// Extract file ID from URL
function extractFileId(url) {
  const match = url.match(/\/files\/(\d+)/);
  return match ? match[1] : null;
}

// Check if URL is a Canvas URL
function isCanvasURL(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url, window.location.origin);
    return urlObj.hostname.includes('canvas.cornell.edu') || 
           urlObj.hostname.includes('instructure.com');
  } catch (e) {
    return false;
  }
}

// Check if URL is an external service
function isExternalService(url) {
  if (!url) return false;
  const externalDomains = [
    'edstem.org',
    'gradescope.com',
    'zoom.us',
    'piazza.com',
    'youtube.com',
    'youtu.be',
    'google.com',
    'docs.google.com',
    'drive.google.com'
  ];
  
  return externalDomains.some(domain => url.includes(domain));
}

// Normalize URL (remove query params that don't affect content)
function normalizeURL(url) {
  try {
    const urlObj = new URL(url);
    // Keep only important query params
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

// Sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-z0-9_\-\.]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 200); // Limit length
}

// Extract text from element, preserving structure
function extractTextWithStructure(element) {
  if (!element) return '';
  
  const clone = element.cloneNode(true);
  
  // Remove script and style elements
  clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  
  // Convert headings to markdown
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

// Get all links from page
function getAllLinks() {
  const links = [];
  const anchors = document.querySelectorAll('a[href]');
  
  for (const anchor of anchors) {
    try {
      const href = new URL(anchor.href, window.location.origin).toString();
      
      // Skip if external or javascript
      if (!isCanvasURL(href) || href.startsWith('javascript:')) {
        continue;
      }
      
      // Skip if external service
      if (isExternalService(href)) {
        continue;
      }
      
      links.push({
        url: normalizeURL(href),
        text: anchor.textContent.trim(),
        title: anchor.title || '',
        context: getElementContext(anchor)
      });
    } catch (e) {
      // Skip invalid URLs
      continue;
    }
  }
  
  return links;
}

// Get context information for an element
function getElementContext(element) {
  const context = {
    module: null,
    section: null,
    type: null
  };
  
  // Find parent module
  const moduleParent = element.closest('[class*="module"], [class*="context_module"]');
  if (moduleParent) {
    const moduleName = moduleParent.querySelector('[class*="module-name"], [class*="module_name"], h2, h3');
    if (moduleName) {
      context.module = moduleName.textContent.trim();
    }
  }
  
  // Find parent section
  const sectionParent = element.closest('[class*="section"], [role="region"]');
  if (sectionParent) {
    const sectionName = sectionParent.querySelector('h1, h2, h3, h4, [class*="title"]');
    if (sectionName) {
      context.section = sectionName.textContent.trim();
    }
  }
  
  // Determine content type
  context.type = determineContentType(element);
  
  return context;
}

// Determine content type from element or URL
function determineContentType(element) {
  const href = element.href || '';
  const text = element.textContent.toLowerCase();
  
  if (href.includes('/files/')) return 'file';
  if (href.includes('/assignments/')) return 'assignment';
  if (href.includes('/pages/')) return 'page';
  if (href.includes('/quizzes/')) return 'quiz';
  if (href.includes('/discussion_topics/')) return 'discussion';
  if (href.includes('/modules/')) return 'module';
  if (href.includes('/announcements/')) return 'announcement';
  if (text.includes('.pdf') || href.includes('.pdf')) return 'pdf';
  if (text.includes('.docx') || text.includes('.doc')) return 'document';
  if (text.includes('.pptx') || text.includes('.ppt')) return 'presentation';
  
  return 'unknown';
}

// Find all scrollable elements on page
function findScrollableElements() {
  const scrollable = [];
  const elements = document.querySelectorAll('*');
  
  for (const el of elements) {
    // Skip if hidden
    if (el.offsetParent === null) continue;
    
    const style = window.getComputedStyle(el);
    const hasVerticalScroll = el.scrollHeight > el.clientHeight;
    const hasHorizontalScroll = el.scrollWidth > el.clientWidth;
    
    const isScrollableY = style.overflowY === 'auto' || 
                          style.overflowY === 'scroll' ||
                          style.overflow === 'auto' ||
                          style.overflow === 'scroll';
    
    const isScrollableX = style.overflowX === 'auto' || 
                          style.overflowX === 'scroll';
    
    if ((hasVerticalScroll && isScrollableY) || (hasHorizontalScroll && isScrollableX)) {
      scrollable.push({
        element: el,
        hasVerticalScroll: hasVerticalScroll && isScrollableY,
        hasHorizontalScroll: hasHorizontalScroll && isScrollableX,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth
      });
    }
  }
  
  // Sort by size (larger containers first)
  scrollable.sort((a, b) => {
    const aSize = a.scrollHeight * a.scrollWidth;
    const bSize = b.scrollHeight * b.scrollWidth;
    return bSize - aSize;
  });
  
  return scrollable;
}

// Scroll element to bottom smoothly
async function scrollToBottom(element, options = {}) {
  const {
    stepSize = 0.8, // Scroll 80% of viewport at a time
    delay = 300,     // Wait 300ms between scrolls
    direction = 'vertical' // 'vertical' or 'horizontal'
  } = options;
  
  const isVertical = direction === 'vertical';
  const scrollProp = isVertical ? 'scrollTop' : 'scrollLeft';
  const scrollMax = isVertical ? element.scrollHeight : element.scrollWidth;
  const clientSize = isVertical ? element.clientHeight : element.clientWidth;
  
  const step = Math.floor(clientSize * stepSize);
  let currentScroll = 0;
  
  while (currentScroll < scrollMax) {
    element[scrollProp] = currentScroll;
    await sleep(delay);
    
    // Check if we've reached the bottom (accounting for dynamic content)
    const newScrollMax = isVertical ? element.scrollHeight : element.scrollWidth;
    if (newScrollMax > scrollMax) {
      // Content was added, update max
      scrollMax = newScrollMax;
    }
    
    currentScroll += step;
  }
  
  // Final scroll to absolute end
  element[scrollProp] = scrollMax;
  await sleep(delay * 2); // Wait longer at the end
}

// Click element safely
function clickElement(element) {
  if (!element) return false;
  
  try {
    // Try multiple click methods
    if (typeof element.click === 'function') {
      element.click();
      return true;
    }
    
    // Fallback to dispatching click event
    const event = new MouseEvent('click', {
      view: window,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(event);
    return true;
  } catch (e) {
    console.error('Failed to click element:', e);
    return false;
  }
}

// Retry operation with exponential backoff
async function retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) {
        throw error;
      }
      const delay = baseDelay * Math.pow(2, i);
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
}

// Log to console and send to popup
function log(message, type = 'info') {
  console.log(`[Canvas Scraper] ${message}`);
  
  try {
    chrome.runtime.sendMessage({
      type: 'log',
      message: message,
      logType: type
    });
  } catch (e) {
    // Popup might be closed, that's okay
  }
}

// Send progress update to popup
function updateProgress(stats) {
  try {
    chrome.runtime.sendMessage({
      type: 'progress_update',
      stats: stats
    });
  } catch (e) {
    // Popup might be closed
  }
}

// Send activity update to popup
function updateActivity(activity) {
  try {
    chrome.runtime.sendMessage({
      type: 'activity_update',
      activity: activity
    });
  } catch (e) {
    // Popup might be closed
  }
}

// Convert HTML to plain text
function htmlToText(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  return temp.textContent || temp.innerText || '';
}

// Check if element is visible
function isElementVisible(element) {
  if (!element) return false;
  
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && 
         style.visibility !== 'hidden' && 
         style.opacity !== '0' &&
         element.offsetParent !== null;
}

// Get page title
function getPageTitle() {
  return document.title || 'Untitled';
}

// Get current URL
function getCurrentURL() {
  return window.location.href;
}

// Format timestamp
function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}
