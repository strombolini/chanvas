// Popup script for extension configuration
document.addEventListener('DOMContentLoaded', function() {
    const openaiApiKeyInput = document.getElementById('openaiApiKey');
    const saveButton = document.getElementById('saveSettings');
    const statusMessage = document.getElementById('statusMessage');

    // Load saved settings
    chrome.storage.sync.get(['openaiApiKey'], function(result) {
        openaiApiKeyInput.value = result.openaiApiKey || '';
    });

    // Save settings
    saveButton.addEventListener('click', function() {
        const apiKey = openaiApiKeyInput.value.trim();

        if (!apiKey) {
            showStatus('Please enter your OpenAI API key', 'error');
            return;
        }

        // Validate API key format (basic check)
        if (!apiKey.startsWith('sk-')) {
            showStatus('Invalid API key format. Should start with "sk-"', 'error');
            return;
        }

        chrome.storage.sync.set({
            openaiApiKey: apiKey
        }, function() {
            showStatus('✓ API key saved successfully!', 'success');
        });
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
