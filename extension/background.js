// Background script to handle cookie extraction, messaging, and auto-scraping
// Import the auto-scraper and RAG system
importScripts('canvas-auto-scraper-v2.js', 'rag.js');

// Initialize the scraper
const scraper = new CanvasAutoScraper();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getCookies') {
        // Extract all cookies for the Canvas domain
        chrome.cookies.getAll({
            domain: request.domain
        }, (cookies) => {
            // Filter for Canvas-related cookies
            const canvasCookies = cookies.filter(cookie => {
                return cookie.domain.includes('cornell.edu') ||
                       cookie.name.includes('canvas') ||
                       cookie.name.includes('session') ||
                       cookie.name.includes('auth');
            });

            sendResponse({ cookies: canvasCookies });
        });

        // Return true to indicate we'll send response asynchronously
        return true;
    }

    // New: Start automated scraping
    if (request.action === 'startAutoScrape') {
        console.log('Received startAutoScrape request');

        // Check if scraping is already in progress
        if (scraper.scrapingInProgress) {
            console.log('[BACKGROUND] Scraping already in progress, rejecting request');
            sendResponse({
                success: false,
                message: 'Scraping already in progress. Please wait for it to complete.'
            });
            return true;
        }

        // Check if we should create a new window or use existing tab
        const createNewWindow = request.createNewWindow !== false; // Default true

        if (!createNewWindow) {
            // Simple mode: scrape in current context
            const progressCallback = (message) => {
                if (sender.tab) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        action: 'scrapeProgress',
                        message: message
                    }).catch(() => {});
                }
            };

            scraper.startAutoScrape(progressCallback, null).then(() => {
                sendResponse({ success: true, message: 'Scraping complete' });
            }).catch((error) => {
                sendResponse({ success: false, message: error.message });
            });

            return true;
        }

        // New window mode: create dedicated scraping window
        const originalTabId = sender.tab?.id;

        // Create a new window for scraping, starting at Canvas dashboard
        chrome.windows.create({
            url: 'https://canvas.cornell.edu/',
            type: 'normal',
            focused: false,
            width: 800,
            height: 600
        }, (newWindow) => {
            const newTabId = newWindow.tabs[0].id;
            console.log(`[BACKGROUND] Created scraping window ${newWindow.id} with tab ${newTabId}`);

            // Mark this window as a scraping window to prevent re-triggering
            chrome.storage.local.set({
                [`scrapingWindow_${newWindow.id}`]: true
            });

            const progressCallback = (message) => {
                // Only send to original tab
                if (originalTabId) {
                    chrome.tabs.sendMessage(originalTabId, {
                        action: 'scrapeProgress',
                        message: message
                    }).catch(() => {});
                }
            };

            // Wait for the new tab to load before starting scrape
            chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
                if (tabId === newTabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);

                    // Small delay to ensure page is fully ready
                    setTimeout(() => {
                        scraper.startAutoScrape(progressCallback, newWindow.id).then(() => {
                            sendResponse({ success: true, message: 'Scraping complete' });

                            // Clean up marker
                            chrome.storage.local.remove(`scrapingWindow_${newWindow.id}`);

                            // Close the scraping window after completion
                            chrome.windows.remove(newWindow.id).catch((err) => {
                                console.log('[BACKGROUND] Could not close scraping window:', err);
                            });
                        }).catch((error) => {
                            sendResponse({ success: false, message: error.message });

                            // Clean up and close window on error
                            chrome.storage.local.remove(`scrapingWindow_${newWindow.id}`);
                            chrome.windows.remove(newWindow.id).catch(() => {});
                        });
                    }, 500);
                }
            });
        });

        return true;
    }

    // New: Get scraped data
    if (request.action === 'getScrapedData') {
        scraper.getScrapedData().then((data) => {
            sendResponse({ success: true, data: data });
        }).catch((error) => {
            sendResponse({ success: false, message: error.message });
        });
        return true;
    }

    // New: Clear scraped data
    if (request.action === 'clearScrapedData') {
        scraper.clearScrapedData().then(() => {
            sendResponse({ success: true });
        }).catch((error) => {
            sendResponse({ success: false, message: error.message });
        });
        return true;
    }

    // Check if current tab is in a scraping window
    if (request.action === 'isScrapingWindow') {
        if (!sender.tab) {
            sendResponse({ isScraping: false });
            return true;
        }

        chrome.windows.get(sender.tab.windowId, (window) => {
            if (chrome.runtime.lastError) {
                sendResponse({ isScraping: false });
                return;
            }

            chrome.storage.local.get([`scrapingWindow_${window.id}`], (result) => {
                const isScraping = result[`scrapingWindow_${window.id}`] === true;
                sendResponse({ isScraping: isScraping });
            });
        });

        return true;
    }
});

// Listen for tab updates to detect navigation to login success page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' &&
        tab.url === 'https://canvas.cornell.edu/?login_success=1') {

        console.log('Login success page detected in tab:', tabId);

        // Could trigger additional actions here if needed
        chrome.tabs.sendMessage(tabId, {
            action: 'loginDetected',
            url: tab.url
        }).catch(error => {
            // Ignore errors if content script isn't ready yet
            console.log('Content script not ready yet:', error);
        });
    }
});

// Handle installation
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Chanvas extension installed');

        // Set default Chanvas URL
        chrome.storage.sync.set({
            chanvasUrl: 'http://localhost:8000'
        });

        // Note: User needs to manually enter OpenAI API key in popup settings
        console.log('Please configure your OpenAI API key in the extension popup');
    }
});