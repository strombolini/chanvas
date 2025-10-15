// Popup script for extension configuration with Google OAuth
document.addEventListener('DOMContentLoaded', function() {
    const chanvasUrlInput = document.getElementById('chanvasUrl');
    const saveButton = document.getElementById('saveSettings');
    const testButton = document.getElementById('testConnection');
    const googleSignInButton = document.getElementById('googleSignIn');
    const signOutButton = document.getElementById('signOut');
    const statusDiv = document.getElementById('status');
    const loginSection = document.getElementById('loginSection');
    const settingsSection = document.getElementById('settingsSection');
    const userInfoDiv = document.getElementById('userInfo');
    const userEmailSpan = document.getElementById('userEmail');

    // Check if user is logged in
    checkLoginStatus();

    // Load saved settings
    chrome.storage.sync.get(['chanvasUrl'], function(result) {
        chanvasUrlInput.value = result.chanvasUrl || 'http://localhost:8000';
    });

    // Google Sign In
    googleSignInButton.addEventListener('click', async function() {
        try {
            showStatus('Signing in with Google...', 'info');

            // Use Chrome identity API for OAuth
            chrome.identity.getAuthToken({ interactive: true }, async function(token) {
                if (chrome.runtime.lastError || !token) {
                    showStatus('Sign in failed: ' + (chrome.runtime.lastError?.message || 'Unknown error'), 'error');
                    return;
                }

                // Get user info from Google
                try {
                    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                        headers: { Authorization: `Bearer ${token}` }
                    });

                    const userInfo = await response.json();
                    const email = userInfo.email;

                    // Check if it's a Cornell email
                    if (!email.endsWith('@cornell.edu')) {
                        showStatus('Please use a Cornell email (@cornell.edu)', 'error');
                        chrome.identity.removeCachedAuthToken({ token: token });
                        return;
                    }

                    // Save user info and token
                    await chrome.storage.sync.set({
                        userEmail: email,
                        userName: userInfo.name,
                        authToken: token,
                        isLoggedIn: true
                    });

                    showStatus('Signed in successfully!', 'success');
                    checkLoginStatus();

                } catch (error) {
                    showStatus('Failed to get user info: ' + error.message, 'error');
                }
            });
        } catch (error) {
            showStatus('Sign in error: ' + error.message, 'error');
        }
    });

    // Sign Out
    signOutButton.addEventListener('click', async function() {
        const result = await chrome.storage.sync.get(['authToken']);
        if (result.authToken) {
            chrome.identity.removeCachedAuthToken({ token: result.authToken }, function() {
                chrome.storage.sync.remove(['userEmail', 'userName', 'authToken', 'isLoggedIn'], function() {
                    showStatus('Signed out successfully', 'success');
                    checkLoginStatus();
                });
            });
        }
    });

    // Save settings
    saveButton.addEventListener('click', function() {
        const url = chanvasUrlInput.value.trim();
        if (!url) {
            showStatus('Please enter a valid URL', 'error');
            return;
        }

        chrome.storage.sync.set({
            chanvasUrl: url
        }, function() {
            showStatus('Settings saved successfully!', 'success');
        });
    });

    // Test connection
    testButton.addEventListener('click', async function() {
        const url = chanvasUrlInput.value.trim();
        if (!url) {
            showStatus('Please enter a valid URL first', 'error');
            return;
        }

        showStatus('Testing connection...', 'info');

        try {
            const response = await fetch(`${url}/api/health`, {
                method: 'GET',
                timeout: 5000
            });

            if (response.ok) {
                showStatus('Connection successful!', 'success');
            } else {
                showStatus(`Connection failed: ${response.status} ${response.statusText}`, 'error');
            }
        } catch (error) {
            showStatus(`Connection failed: ${error.message}`, 'error');
        }
    });

    // Check login status and update UI
    async function checkLoginStatus() {
        const result = await chrome.storage.sync.get(['isLoggedIn', 'userEmail']);

        if (result.isLoggedIn && result.userEmail) {
            // User is logged in
            loginSection.style.display = 'none';
            settingsSection.style.display = 'block';
            userInfoDiv.style.display = 'block';
            userEmailSpan.textContent = result.userEmail;
        } else {
            // User is not logged in
            loginSection.style.display = 'block';
            settingsSection.style.display = 'none';
            userInfoDiv.style.display = 'none';
        }
    }

    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
        statusDiv.style.display = 'block';

        // Hide after 3 seconds for success/info messages
        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
        }
    }
});
