// Content script to detect Canvas login success and trigger scraping
(function() {
    'use strict';

    // Check if we're on the login success page
    function isLoginSuccessPage() {
        return window.location.href === 'https://canvas.cornell.edu/?login_success=1';
    }

    // Extract all Canvas cookies for session
    async function extractCanvasCookies() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'getCookies',
                domain: '.cornell.edu'
            }, (response) => {
                resolve(response.cookies || []);
            });
        });
    }

    // Send session data to Chanvas backend
    async function sendSessionToChangas(cookies) {
        try {
            // Get Chanvas URL from extension storage (configurable)
            const result = await chrome.storage.sync.get(['chanvasUrl']);
            const chanvasUrl = result.chanvasUrl || 'http://localhost:8000';

            const response = await fetch(`${chanvasUrl}/api/session-login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    canvas_cookies: cookies,
                    canvas_url: window.location.origin,
                    timestamp: Date.now()
                })
            });

            if (response.ok) {
                const result = await response.json();
                console.log('Session sent to Chanvas successfully:', result);
                showNotification('Canvas session captured! Scraping will begin automatically.');
                return result;
            } else {
                console.error('Failed to send session to Chanvas:', response.statusText);
                showNotification('Failed to connect to Chanvas. Please check if the service is running.');
            }
        } catch (error) {
            console.error('Error sending session to Chanvas:', error);
            showNotification('Error connecting to Chanvas: ' + error.message);
        }
    }

    // Show notification to user
    function showNotification(message) {
        // Create a temporary notification div
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #2d5aa0;
            color: white;
            padding: 15px 20px;
            border-radius: 8px;
            z-index: 10000;
            font-family: Arial, sans-serif;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            max-width: 300px;
        `;
        notification.textContent = message;

        document.body.appendChild(notification);

        // Remove after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
    }

    // Trigger automated scraping
    async function triggerAutoScrape() {
        showNotification('Starting automated Canvas scraping...');

        chrome.runtime.sendMessage({
            action: 'startAutoScrape'
        }, (response) => {
            if (response && response.success) {
                showNotification('✓ Canvas scraping complete! Your courses have been indexed.');
            } else {
                showNotification('✗ Scraping failed: ' + (response?.message || 'Unknown error'));
            }
        });
    }

    // Listen for progress updates from background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'scrapeProgress') {
            showNotification(request.message);
        }
    });

    // Check if this tab is in a scraping window
    async function isScrapingWindow() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'isScrapingWindow'
            }, (response) => {
                resolve(response?.isScraping || false);
            });
        });
    }

    // Main execution
    async function main() {
        // Don't trigger auto-scrape if we're already in a scraping window
        const inScrapingWindow = await isScrapingWindow();
        if (inScrapingWindow) {
            console.log('[CONTENT] In scraping window, skipping auto-trigger');
            return;
        }

        if (isLoginSuccessPage()) {
            console.log('Canvas login success detected!');
            showNotification('Canvas login detected. Starting auto-scrape...');

            // Wait a moment for cookies to be set and page to settle
            setTimeout(async () => {
                const cookies = await extractCanvasCookies();
                console.log('Extracted cookies:', cookies);

                if (cookies.length > 0) {
                    // Trigger in-browser auto-scraping
                    await triggerAutoScrape();
                } else {
                    console.error('No Canvas cookies found');
                    showNotification('No Canvas session cookies found. Please try logging in again.');
                }
            }, 1000);
        }
    }

    // Run when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

    // Also run when URL changes (for single-page app navigation)
    let currentUrl = window.location.href;
    const observer = new MutationObserver(() => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            main();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
})();