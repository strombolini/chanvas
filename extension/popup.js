// Popup script for extension configuration
document.addEventListener('DOMContentLoaded', function() {
    const chanvasUrlInput = document.getElementById('chanvasUrl');
    const openaiApiKeyInput = document.getElementById('openaiApiKey');
    const saveButton = document.getElementById('saveSettings');
    const testButton = document.getElementById('testConnection');
    const statusMessage = document.getElementById('statusMessage');

    // Load saved settings
    chrome.storage.sync.get(['chanvasUrl', 'openaiApiKey'], function(result) {
        chanvasUrlInput.value = result.chanvasUrl || 'http://localhost:8000';
        openaiApiKeyInput.value = result.openaiApiKey || '';
    });

    // Save settings
    saveButton.addEventListener('click', function() {
        const url = chanvasUrlInput.value.trim();
        const apiKey = openaiApiKeyInput.value.trim();

        if (!url) {
            showStatus('Please enter a valid URL', 'error');
            return;
        }

        if (!apiKey) {
            showStatus('Please enter your OpenAI API key', 'error');
            return;
        }

        chrome.storage.sync.set({
            chanvasUrl: url,
            openaiApiKey: apiKey
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
                method: 'GET'
            });

            if (response.ok) {
                showStatus('✓ Connection successful!', 'success');
            } else {
                showStatus(`✗ Connection failed: ${response.status}`, 'error');
            }
        } catch (error) {
            showStatus(`✗ Connection failed: ${error.message}`, 'error');
        }
    });

    function showStatus(message, type) {
        statusMessage.textContent = message;
        statusMessage.style.display = 'block';

        // Style based on type
        if (type === 'success') {
            statusMessage.style.background = '#d4edda';
            statusMessage.style.color = '#155724';
            statusMessage.style.border = '1px solid #c3e6cb';
        } else if (type === 'error') {
            statusMessage.style.background = '#f8d7da';
            statusMessage.style.color = '#721c24';
            statusMessage.style.border = '1px solid #f5c6cb';
        } else {
            statusMessage.style.background = '#d1ecf1';
            statusMessage.style.color = '#0c5460';
            statusMessage.style.border = '1px solid #bee5eb';
        }

        // Hide after 3 seconds for success/info messages
        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                statusMessage.style.display = 'none';
            }, 3000);
        }
    }
});
