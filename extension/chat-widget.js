// Chat Widget Logic
(function() {
    'use strict';

    // DOM elements
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const closeBtn = document.getElementById('closeBtn');
    const chatStatus = document.getElementById('chatStatus');

    // State
    let conversationHistory = [];
    let isProcessing = false;
    let openaiApiKey = null;

    // Initialize
    async function init() {
        console.log('[CHAT WIDGET] Initializing...');

        // Load OpenAI API key
        const result = await chrome.storage.sync.get(['openaiApiKey']);
        openaiApiKey = result.openaiApiKey;

        console.log('[CHAT WIDGET] API key loaded:', !!openaiApiKey);

        if (!openaiApiKey) {
            showError('Please configure your OpenAI API key in the extension settings.');
            return;
        }

        // Check if compressed context exists
        const scrapedData = await chrome.storage.local.get(['scrapedCanvasData']);
        if (scrapedData.scrapedCanvasData && scrapedData.scrapedCanvasData.courses) {
            const compressedContext = scrapedData.scrapedCanvasData.courses._compressedContext;
            if (compressedContext) {
                const contextLength = compressedContext.length;
                updateStatus(`Course data available (${Math.round(contextLength / 1000)}k chars)`);
                console.log('[CHAT WIDGET] Compressed context found:', contextLength, 'characters');
            } else {
                updateStatus('No course data. Please scrape your Canvas courses first.');
            }
        } else {
            updateStatus('No course data. Please scrape your Canvas courses first.');
        }

        // Load chat history
        loadChatHistory();

        // Event listeners
        sendBtn.addEventListener('click', sendMessage);
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        closeBtn.addEventListener('click', () => {
            window.parent.postMessage({ type: 'CHANVAS_CLOSE_CHAT' }, '*');
        });

        // Auto-resize textarea
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });
    }

    // Update status
    function updateStatus(message) {
        chatStatus.textContent = message;
    }

    // Show error
    function showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        chatMessages.appendChild(errorDiv);
        scrollToBottom();
    }

    // Load chat history from storage
    async function loadChatHistory() {
        const result = await chrome.storage.local.get(['chatHistory']);
        if (result.chatHistory && result.chatHistory.length > 0) {
            conversationHistory = result.chatHistory;

            // Remove empty state
            const emptyState = chatMessages.querySelector('.empty-state');
            if (emptyState) {
                emptyState.remove();
            }

            // Render messages
            conversationHistory.forEach(msg => {
                addMessageToUI(msg.role, msg.content, false);
            });
        }
    }

    // Save chat history to storage
    async function saveChatHistory() {
        await chrome.storage.local.set({ chatHistory: conversationHistory });
    }

    // Add message to UI
    function addMessageToUI(role, content, animate = true) {
        // Remove empty state if exists
        const emptyState = chatMessages.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        if (!animate) {
            messageDiv.style.animation = 'none';
        }

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = role === 'user' ? '👤' : '🤖';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        // Format content (simple markdown-like formatting)
        const formattedContent = formatMessageContent(content);
        contentDiv.innerHTML = formattedContent;

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        scrollToBottom();
    }

    function createStreamingMessageElement(role) {
        const emptyState = chatMessages.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = role === 'user' ? '👤' : '🤖';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = '';

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        scrollToBottom();

        return { messageDiv, contentDiv };
    }

    // Format message content
    function formatMessageContent(content) {
        // Convert line breaks
        let formatted = content.replace(/\n/g, '<br>');

        // Convert inline code
        formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

        return formatted;
    }

    // Show typing indicator
    function showTypingIndicator() {
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message assistant';
        typingDiv.id = 'typingIndicator';

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = '🤖';

        const indicator = document.createElement('div');
        indicator.className = 'message-content';
        indicator.innerHTML = `
            <div class="typing-indicator">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;

        typingDiv.appendChild(avatar);
        typingDiv.appendChild(indicator);
        chatMessages.appendChild(typingDiv);
        scrollToBottom();
    }

    // Remove typing indicator
    function removeTypingIndicator() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.remove();
        }
    }

    // Scroll to bottom
    function scrollToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Get current US Eastern date
    function getUSEasternDate() {
        // Get current time in US Eastern timezone
        const now = new Date();
        const easternTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
        
        // Format as: "December 25, 2024"
        const options = { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            timeZone: 'America/New_York'
        };
        return easternTime.toLocaleDateString('en-US', options);
    }

    // Send message
    async function sendMessage() {
        console.log('[CHAT WIDGET] Send message triggered');
        let message = chatInput.value.trim();
        console.log('[CHAT WIDGET] Message:', message);
        console.log('[CHAT WIDGET] Is processing:', isProcessing);

        if (!message || isProcessing) {
            console.log('[CHAT WIDGET] Blocked: empty message or already processing');
            return;
        }

        if (!openaiApiKey) {
            console.error('[CHAT WIDGET] No API key configured');
            showError('OpenAI API key not configured. Please set it in the extension settings.');
            return;
        }

        console.log('[CHAT WIDGET] Proceeding with message send');

        // Add current US Eastern date to the message
        const currentDate = getUSEasternDate();
        const messageWithDate = `[Current Date: ${currentDate}]\n\n${message}`;

        // Clear input
        chatInput.value = '';
        chatInput.style.height = 'auto';

        // Add user message to UI (show original message without date prefix in UI)
        addMessageToUI('user', message);

        // Add to history (use messageWithDate so date is included in conversation)
        conversationHistory.push({
            role: 'user',
            content: messageWithDate  // Include date in the actual message sent to API
        });
        saveChatHistory();

        // Disable input
        isProcessing = true;
        sendBtn.disabled = true;
        chatInput.disabled = true;

        // Show typing indicator
        showTypingIndicator();

        let assistantMessageBuffer = '';
        let assistantContentDiv = null;
        let assistantMessageElement = null;

        const ensureAssistantMessageElement = () => {
            if (!assistantContentDiv) {
                removeTypingIndicator();
                const streamingElements = createStreamingMessageElement('assistant');
                assistantMessageElement = streamingElements.messageDiv;
                assistantContentDiv = streamingElements.contentDiv;
            }
        };

        try {
            // Get compressed context from storage
            console.log('[CHAT WIDGET] Retrieving compressed context from storage...');
            const scrapedData = await chrome.storage.local.get(['scrapedCanvasData']);
            let compressedContext = null;
            
            if (scrapedData.scrapedCanvasData && scrapedData.scrapedCanvasData.courses) {
                compressedContext = scrapedData.scrapedCanvasData.courses._compressedContext;
                if (compressedContext) {
                    console.log('[CHAT WIDGET] Compressed context retrieved:', compressedContext.length, 'characters');
                } else {
                    console.warn('[CHAT WIDGET] No compressed context found in courses data');
                }
            } else {
                console.warn('[CHAT WIDGET] No scraped data found');
            }

            if (!compressedContext) {
                console.warn('[CHAT WIDGET] No context available - proceeding without context');
                updateStatus('No course data available. Please scrape your Canvas courses first.');
            }

            // Build messages for OpenAI
            console.log('[CHAT WIDGET] Building messages for OpenAI...');
            const messages = [];
            
            // Add system message with context if available
            if (compressedContext) {
                messages.push({
                    role: 'system',
                    content: `You are a helpful assistant for Canvas course questions. Use the following cleaned and organized course content from the user's Canvas courses to answer their question. The content has been cleaned of HTML artifacts and organized by course.

If the context doesn't contain relevant information to answer the question, say so clearly. Provide clear, concise answers based on the context.

=== COURSE CONTENT ===
${compressedContext}
=== END COURSE CONTENT ===`
                });
            } else {
                messages.push({
                    role: 'system',
                    content: `You are a helpful assistant for Canvas course questions. The user has not scraped their Canvas courses yet, so you don't have access to their course content. Please let them know they need to scrape their courses first.`
                });
            }
            
            // Add conversation history
            messages.push(...conversationHistory.slice(-10)); // Last 10 messages for context

            // Call OpenAI API with GPT-5-nano
            console.log('[CHAT WIDGET] Calling OpenAI API with GPT-5-nano...');
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-5-nano',
                    stream: true,
                    messages: messages
                })
            });

            console.log('[CHAT WIDGET] API response status:', response.status);

            if (!response.ok) {
                let errorDetail = 'API request failed';
                try {
                    const error = await response.json();
                    console.error('[CHAT WIDGET] API error:', error);
                    errorDetail = error.error?.message || errorDetail;
                } catch (_) {}
                throw new Error(errorDetail);
            }

            const reader = response.body?.getReader ? response.body.getReader() : null;

            if (reader) {
                const decoder = new TextDecoder();
                let buffer = '';
                let streamingComplete = false;

                const processBuffer = () => {
                    const parts = buffer.split('\n\n');
                    buffer = parts.pop();
                    for (const part of parts) {
                        const trimmed = part.trim();
                        if (!trimmed.startsWith('data:')) continue;
                        const dataStr = trimmed.slice(5).trim();
                        if (!dataStr || dataStr === '[DONE]') {
                            streamingComplete = true;
                            continue;
                        }
                        let payload;
                        try {
                            payload = JSON.parse(dataStr);
                        } catch (e) {
                            console.warn('[CHAT WIDGET] Failed to parse stream chunk:', e);
                            continue;
                        }
                        const delta = payload.choices?.[0]?.delta;
                        if (delta?.content) {
                            ensureAssistantMessageElement();
                            assistantMessageBuffer += delta.content;
                            assistantContentDiv.innerHTML = formatMessageContent(assistantMessageBuffer);
                            scrollToBottom();
                        }
                    }
                };

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    processBuffer();
                    if (streamingComplete) break;
                }

                if (buffer.trim()) {
                    processBuffer();
                }
            } else {
                console.warn('[CHAT WIDGET] Streaming not supported, falling back to standard response.');
                const data = await response.json();
                const assistantMessage = data.choices[0]?.message?.content || '';
                ensureAssistantMessageElement();
                assistantMessageBuffer = assistantMessage;
                assistantContentDiv.innerHTML = formatMessageContent(assistantMessageBuffer);
                scrollToBottom();
            }

            ensureAssistantMessageElement();
            removeTypingIndicator();

            let finalAssistantMessage = assistantMessageBuffer.trim();
            if (!finalAssistantMessage) {
                finalAssistantMessage = 'I’m sorry, I could not generate a response.';
                assistantContentDiv.innerHTML = formatMessageContent(finalAssistantMessage);
            }

            conversationHistory.push({
                role: 'assistant',
                content: finalAssistantMessage
            });
            saveChatHistory();

        } catch (error) {
            console.error('[CHAT] Error:', error);
            removeTypingIndicator();
            showError(`Error: ${error.message}`);
        } finally {
            // Re-enable input
            isProcessing = false;
            sendBtn.disabled = false;
            chatInput.disabled = false;
            chatInput.focus();
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Listen for messages from parent (for clearing chat, etc.)
    window.addEventListener('message', (event) => {
        if (event.data.type === 'CHANVAS_CLEAR_CHAT') {
            conversationHistory = [];
            saveChatHistory();
            chatMessages.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">💭</div>
                    <div class="empty-state-title">Start a conversation</div>
                    <div class="empty-state-text">Ask me anything about your Canvas courses!</div>
                </div>
            `;
        }
    });
})();
