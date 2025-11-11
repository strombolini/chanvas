// Popup script for extension configuration
document.addEventListener('DOMContentLoaded', function() {
    const openaiApiKeyInput = document.getElementById('openaiApiKey');
    const saveButton = document.getElementById('saveSettings');
    const startScrapeButton = document.getElementById('startScrape');
    const stopScrapeButton = document.getElementById('stopScrape');
    const downloadButton = document.getElementById('downloadCorpus');
    const syllabusOnlyCheckbox = document.getElementById('syllabusOnlyMode');
    const statusMessage = document.getElementById('statusMessage');
    const progressIndicator = document.getElementById('progressIndicator');
    const progressCircle = document.getElementById('progressCircle');
    const progressText = document.getElementById('progressText');

    // Load saved settings
    chrome.storage.sync.get(['openaiApiKey', 'syllabusOnlyMode'], function(result) {
        openaiApiKeyInput.value = result.openaiApiKey || '';
        syllabusOnlyCheckbox.checked = result.syllabusOnlyMode || false;
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

    // Listen for progress updates from scraping
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'scrapeProgress') {
            // Check if this is a progress update (format: "progress:X/Y")
            if (request.message && request.message.startsWith('progress:')) {
                const progressMatch = request.message.match(/progress:(\d+)\/(\d+)/);
                if (progressMatch) {
                    const current = parseInt(progressMatch[1]);
                    const total = parseInt(progressMatch[2]);
                    
                    // Show progress indicator
                    progressIndicator.style.display = 'block';
                    
                    // Update text
                    progressText.textContent = `${current}/${total}`;
                    
                    // Update circle (circumference = 2 * π * r, where r = 16)
                    const circumference = 2 * Math.PI * 16;
                    const progressPercent = total > 0 ? current / total : 0;
                    const offset = circumference * (1 - progressPercent);
                    progressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
                    progressCircle.style.strokeDashoffset = offset;
                }
            } else {
                // Check for completion messages
                if (request.message && (request.message.includes('complete') || request.message.includes('Complete'))) {
                    // Hide progress indicator after a short delay when complete
                    setTimeout(() => {
                        progressIndicator.style.display = 'none';
                    }, 1000);
                }
                // Regular progress message - update status but don't hide progress
                showStatus(request.message, 'info');
            }
        }
    });

    // Start scraping
    startScrapeButton.addEventListener('click', async function() {
        try {
            showStatus('Starting scrape...', 'info');
            startScrapeButton.disabled = true;
            stopScrapeButton.style.display = 'block';
            startScrapeButton.style.display = 'none';
            
            // Save syllabus-only mode preference
            const syllabusOnly = syllabusOnlyCheckbox.checked;
            chrome.storage.sync.set({ syllabusOnlyMode: syllabusOnly });

            // Request scraping (will open in separate window)
            chrome.runtime.sendMessage({
                action: 'startAutoScrape',
                createNewWindow: true,
                syllabusOnlyMode: syllabusOnly
            }, (response) => {
                if (chrome.runtime.lastError) {
                    showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                    startScrapeButton.disabled = false;
                    stopScrapeButton.style.display = 'none';
                    startScrapeButton.style.display = 'block';
                    return;
                }

                if (response && response.success) {
                    showStatus('Scraping started! Check the scraping window.', 'success');
                } else {
                    showStatus(response?.message || 'Failed to start scraping', 'error');
                    startScrapeButton.disabled = false;
                    stopScrapeButton.style.display = 'none';
                    startScrapeButton.style.display = 'block';
                }
            });
        } catch (error) {
            showStatus('Error: ' + error.message, 'error');
            startScrapeButton.disabled = false;
            stopScrapeButton.style.display = 'none';
            startScrapeButton.style.display = 'block';
        }
    });

    // Stop scraping
    stopScrapeButton.addEventListener('click', async function() {
        try {
            showStatus('Stopping scrape...', 'info');
            stopScrapeButton.disabled = true;

            chrome.runtime.sendMessage({
                action: 'stopAutoScrape'
            }, (response) => {
                if (response && response.success) {
                    showStatus('Scraping stopped. Processing collected data...', 'success');
                } else {
                    showStatus(response?.message || 'Error stopping scrape', 'error');
                }
                
                // Hide progress indicator
                progressIndicator.style.display = 'none';
                
                // Reset buttons after a delay
                setTimeout(() => {
                    stopScrapeButton.disabled = false;
                    stopScrapeButton.style.display = 'none';
                    startScrapeButton.style.display = 'block';
                    startScrapeButton.disabled = false;
                }, 2000);
            });
        } catch (error) {
            showStatus('Error: ' + error.message, 'error');
            stopScrapeButton.disabled = false;
        }
    });

    // Download corpus with embedding markers
    downloadButton.addEventListener('click', async function() {
        try {
            showStatus('Preparing corpus download...', 'info');
            downloadButton.disabled = true;

            // Get scraped data
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

            // Get indexed data using RAG system
            const rag = new ExtensionRAG();
            await rag.init();
            const indexData = await rag._loadIndexAny();

            // Build corpus with embedding markers
            const corpusExport = {
                metadata: {
                    exportedAt: new Date().toISOString(),
                    scrapedAt: canvasData.lastScraped ? new Date(canvasData.lastScraped).toISOString() : null,
                    version: canvasData.version || 'unknown',
                    totalCourses: Object.keys(canvasData.courses).length,
                    totalChunks: indexData ? indexData.chunks.length : 0,
                    indexedAt: indexData && indexData.indexedAt ? new Date(indexData.indexedAt).toISOString() : null
                },
                courses: {}
            };

            // Process each course
            for (const courseId in canvasData.courses) {
                const course = canvasData.courses[courseId];
                const courseExport = {
                    id: courseId,
                    name: course.name,
                    scrapedAt: course.scrapedAt ? new Date(course.scrapedAt).toISOString() : null,
                    pages: {}
                };

                // Process each page in the course
                for (const pageName in course.pages) {
                    const page = course.pages[pageName];
                    const pageExport = {
                        url: page.url,
                        title: page.title || '',
                        content: page.content || '',
                        textLength: page.textLength || 0,
                        embeddedChunks: []
                    };

                    // Find chunks that belong to this course and contain this page's content
                    if (indexData && indexData.chunks && indexData.metadata) {
                        const pageMarker = `=== ${pageName.toUpperCase()} ===`;
                        for (let i = 0; i < indexData.metadata.length; i++) {
                            const chunkMeta = indexData.metadata[i];
                            if (chunkMeta.courseId === courseId) {
                                const chunkText = indexData.chunks[i];
                                
                                // Check if this chunk contains the page marker or page content
                                // Chunks are created by concatenating all pages with markers like "=== PAGE_NAME ==="
                                if (chunkText.includes(pageMarker) || 
                                    chunkText.includes(page.content.substring(0, 100))) {
                                    pageExport.embeddedChunks.push({
                                        chunkIndex: i,
                                        chunkText: chunkText,
                                        chunkIndexInCourse: chunkMeta.chunkIndex || 0,
                                        totalChunksInCourse: chunkMeta.totalChunks || 0,
                                        hasEmbedding: true,
                                        metadata: {
                                            courseId: chunkMeta.courseId,
                                            courseName: chunkMeta.courseName,
                                            chunkIndex: chunkMeta.chunkIndex,
                                            totalChunks: chunkMeta.totalChunks
                                        }
                                    });
                                }
                            }
                        }
                    }

                    courseExport.pages[pageName] = pageExport;
                }

                corpusExport.courses[courseId] = courseExport;
            }

            // Create download
            const jsonData = JSON.stringify(corpusExport, null, 2);
            const blob = new Blob([jsonData], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chanvas-corpus-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showStatus(`✓ Corpus downloaded! (${Object.keys(canvasData.courses).length} courses, ${indexData ? indexData.chunks.length : 0} chunks)`, 'success');
            downloadButton.disabled = false;

        } catch (error) {
            console.error('Error downloading corpus:', error);
            showStatus(`Error: ${error.message}`, 'error');
            downloadButton.disabled = false;
        }
    });
});
