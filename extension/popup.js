// Popup script for extension configuration
document.addEventListener('DOMContentLoaded', function() {
    const openaiApiKeyInput = document.getElementById('openaiApiKey');
    const saveButton = document.getElementById('saveSettings');
    const downloadButton = document.getElementById('downloadCorpus');
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

    // Download raw corpus (plain text format as fed into RAG model)
    downloadButton.addEventListener('click', async function() {
        try {
            showStatus('Preparing corpus download...', 'info');
            downloadButton.disabled = true;

            // Get scraped data (already has HTML stripped)
            const canvasData = await new Promise((resolve) => {
                chrome.storage.local.get(['canvasData'], (result) => {
                    resolve(result.canvasData || null);
                });
            });

            if (!canvasData || !canvasData.courses) {
                showStatus('No scraped data found. Please scrape courses first.', 'error');
                downloadButton.disabled = false;
                return;
            }

            // Build raw text exactly like RAG model does
            let rawText = '';
            for (const courseId in canvasData.courses) {
                const course = canvasData.courses[courseId];
                rawText += `Course: ${course.name} (ID: ${courseId})\n\n`;
                for (const pageName in course.pages) {
                    const page = course.pages[pageName];
                    rawText += `\n=== ${pageName.toUpperCase()} ===\n`;
                    rawText += page.content; // Already HTML-stripped
                    rawText += '\n\n';
                }
            }

            // Create download as plain text file
            const blob = new Blob([rawText], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chanvas-corpus-raw-${new Date().toISOString().split('T')[0]}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showStatus(`✓ Raw corpus downloaded! (${Object.keys(canvasData.courses).length} courses)`, 'success');
            downloadButton.disabled = false;

        } catch (error) {
            console.error('Error downloading corpus:', error);
            showStatus(`Error: ${error.message}`, 'error');
            downloadButton.disabled = false;
        }
    });
});
