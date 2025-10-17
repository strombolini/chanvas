// Content script injected into Chanvas web app pages
// Bridges communication between web app and extension storage

(function() {
    'use strict';

    console.log('[CHANVAS BRIDGE] Content script loaded');

    // Listen for messages from the web page
    window.addEventListener('message', async function(event) {
        // Only accept messages from same origin
        if (event.source !== window) {
            return;
        }

        if (event.data.type === 'CHANVAS_GET_DATA') {
            console.log('[CHANVAS BRIDGE] Received request for Canvas data');

            try {
                // Get data from chrome.storage.local
                const result = await new Promise((resolve) => {
                    chrome.storage.local.get(['canvasData'], (data) => {
                        resolve(data);
                    });
                });

                const canvasData = result.canvasData || null;

                if (canvasData && canvasData.courses) {
                    console.log('[CHANVAS BRIDGE] Found data for', Object.keys(canvasData.courses).length, 'courses');
                } else {
                    console.log('[CHANVAS BRIDGE] No data found');
                }

                // Send data back to web page
                window.postMessage({
                    type: 'CHANVAS_DATA_RESPONSE',
                    data: canvasData,
                    requestId: event.data.requestId
                }, '*');

            } catch (error) {
                console.error('[CHANVAS BRIDGE] Error retrieving data:', error);
                window.postMessage({
                    type: 'CHANVAS_DATA_RESPONSE',
                    data: null,
                    error: error.message,
                    requestId: event.data.requestId
                }, '*');
            }
        }

        if (event.data.type === 'CHANVAS_GET_RAG_INDEX') {
            console.log('[CHANVAS BRIDGE] Received request for RAG index');

            try {
                // Get RAG index from chrome.storage.local
                const result = await new Promise((resolve) => {
                    chrome.storage.local.get(['ragIndex'], (data) => {
                        resolve(data);
                    });
                });

                const ragIndex = result.ragIndex || null;

                if (ragIndex && ragIndex.chunks) {
                    console.log('[CHANVAS BRIDGE] Found RAG index with', ragIndex.chunks.length, 'chunks');
                } else {
                    console.log('[CHANVAS BRIDGE] No RAG index found');
                }

                // Send RAG index back to web page
                window.postMessage({
                    type: 'CHANVAS_RAG_RESPONSE',
                    ragIndex: ragIndex,
                    requestId: event.data.requestId
                }, '*');

            } catch (error) {
                console.error('[CHANVAS BRIDGE] Error retrieving RAG index:', error);
                window.postMessage({
                    type: 'CHANVAS_RAG_RESPONSE',
                    ragIndex: null,
                    error: error.message,
                    requestId: event.data.requestId
                }, '*');
            }
        }
    });

    // Signal that bridge is ready
    window.postMessage({
        type: 'CHANVAS_BRIDGE_READY'
    }, '*');
})();
