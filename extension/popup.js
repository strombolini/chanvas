// Popup script for extension configuration
document.addEventListener('DOMContentLoaded', function() {
    const chanvasUrlInput = document.getElementById('chanvasUrl');
    const saveButton = document.getElementById('saveSettings');
    const testButton = document.getElementById('testConnection');
    const statusDiv = document.getElementById('status');

    // Load saved settings
    chrome.storage.sync.get(['chanvasUrl'], function(result) {
        chanvasUrlInput.value = result.chanvasUrl || 'http://localhost:8000';
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
                const data = await response.json();
                showStatus('Connection successful!', 'success');
            } else {
                showStatus(`Connection failed: ${response.status} ${response.statusText}`, 'error');
            }
        } catch (error) {
            showStatus(`Connection failed: ${error.message}`, 'error');
        }
    });

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