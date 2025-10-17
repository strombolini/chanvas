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

        // Progress callback to send updates back to content script
        const progressCallback = (message) => {
            // Send progress update to the requesting tab
            if (sender.tab) {
                chrome.tabs.sendMessage(sender.tab.id, {
                    action: 'scrapeProgress',
                    message: message
                }).catch(() => {
                    // Ignore errors if content script isn't listening
                });
            }
        };

        scraper.startAutoScrape(progressCallback).then(() => {
            sendResponse({ success: true, message: 'Scraping complete' });
        }).catch((error) => {
            sendResponse({ success: false, message: error.message });
        });
        return true; // Will respond asynchronously
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