// Background script to handle cookie extraction and messaging
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
    }
});