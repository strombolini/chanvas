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
    let ragInstance = null;

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

        // Initialize RAG
        console.log('[CHAT WIDGET] Initializing RAG...');
        ragInstance = new ExtensionRAG();
        await ragInstance.init();
        console.log('[CHAT WIDGET] RAG initialized');

        // Check if data is indexed
        const ragData = await chrome.storage.local.get(['ragIndex']);
        if (ragData.ragIndex && ragData.ragIndex.chunks) {
            updateStatus(`${ragData.ragIndex.chunks.length} chunks indexed`);
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

    // Send message
    async function sendMessage() {
        console.log('[CHAT WIDGET] Send message triggered');
        const message = chatInput.value.trim();
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

        // Clear input
        chatInput.value = '';
        chatInput.style.height = 'auto';

        // Add user message to UI
        addMessageToUI('user', message);

        // Add to history
        conversationHistory.push({
            role: 'user',
            content: message
        });
        saveChatHistory();

        // Disable input
        isProcessing = true;
        sendBtn.disabled = true;
        chatInput.disabled = true;

        // Show typing indicator
        showTypingIndicator();

        try {
            // Get relevant context from RAG
            console.log('[CHAT WIDGET] Retrieving context from RAG...');
            const ragContext = await ragInstance.retrieveContext(message);
            console.log('[CHAT WIDGET] RAG context retrieved:', ragContext.chunks?.length, 'chunks');

            // Build messages for OpenAI
            console.log('[CHAT WIDGET] Building messages for OpenAI...');
            const messages = [
                {
                    role: 'system',
                    content: `You are a helpful assistant for Canvas course questions. Use the following context from the user's Canvas courses to answer their question. If the context doesn't contain relevant information, say so.

Context:
${ragContext.context || 'No relevant context found.'}

Provide clear, concise answers based on the context above.`
                },
                ...conversationHistory.slice(-10) // Last 10 messages for context
            ];

            // Call OpenAI API
            console.log('[CHAT WIDGET] Calling OpenAI API...');
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: 1000
                })
            });

            console.log('[CHAT WIDGET] API response status:', response.status);

            if (!response.ok) {
                const error = await response.json();
                console.error('[CHAT WIDGET] API error:', error);
                throw new Error(error.error?.message || 'API request failed');
            }

            const data = await response.json();
            console.log('[CHAT WIDGET] API response received');
            const assistantMessage = data.choices[0].message.content;
            console.log('[CHAT WIDGET] Assistant message:', assistantMessage.substring(0, 100));

            // Remove typing indicator
            removeTypingIndicator();

            // Add assistant message to UI
            addMessageToUI('assistant', assistantMessage);

            // Add to history
            conversationHistory.push({
                role: 'assistant',
                content: assistantMessage
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
