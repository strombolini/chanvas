// Simple debug version of content script
console.log('Debug content script loaded!');
console.log('Current URL:', window.location.href);
console.log('Is login success page?:', window.location.href === 'https://canvas.cornell.edu/?login_success=1');

// Test if we can extract cookies
chrome.runtime.sendMessage({
    action: 'getCookies',
    domain: '.cornell.edu'
}, (response) => {
    console.log('Cookie response:', response);
    if (response && response.cookies) {
        console.log('Found cookies:', response.cookies.length);

        // Try to send to backend
        fetch('http://localhost:8000/api/session-login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                canvas_cookies: response.cookies,
                canvas_url: window.location.origin,
                timestamp: Date.now()
            })
        })
        .then(response => response.json())
        .then(data => {
            console.log('Backend response:', data);
        })
        .catch(error => {
            console.error('Backend error:', error);
        });
    }
});