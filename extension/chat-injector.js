// Content script to inject chat widget on Canvas pages
(function() {
    'use strict';

    console.log('[CHANVAS CHAT] Injector loaded');

    let chatWidget = null;
    let chatButton = null;

    // Create floating chat button
    function createChatButton() {
        chatButton = document.createElement('div');
        chatButton.id = 'chanvas-chat-button';
        chatButton.innerHTML = '💬';
        chatButton.title = 'Open Chanvas Chat';

        // Styles
        Object.assign(chatButton.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #2d5aa0 0%, #1e3d6f 100%)',
            color: 'white',
            fontSize: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(45, 90, 160, 0.4)',
            zIndex: '999999',
            transition: 'all 0.3s ease',
            userSelect: 'none'
        });

        // Hover effect
        chatButton.addEventListener('mouseenter', () => {
            chatButton.style.transform = 'scale(1.1)';
            chatButton.style.boxShadow = '0 6px 16px rgba(45, 90, 160, 0.5)';
        });

        chatButton.addEventListener('mouseleave', () => {
            chatButton.style.transform = 'scale(1)';
            chatButton.style.boxShadow = '0 4px 12px rgba(45, 90, 160, 0.4)';
        });

        // Click to toggle chat
        chatButton.addEventListener('click', toggleChat);

        document.body.appendChild(chatButton);
    }

    // Create chat widget
    function createChatWidget() {
        // Container for chat widget
        const container = document.createElement('div');
        container.id = 'chanvas-chat-widget';

        // Initial position - bottom right
        const initialBottom = 90;
        const initialRight = 20;
        const initialWidth = 400;
        const initialHeight = 600;

        Object.assign(container.style, {
            position: 'fixed',
            bottom: `${initialBottom}px`,
            right: `${initialRight}px`,
            width: `${initialWidth}px`,
            height: `${initialHeight}px`,
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
            zIndex: '2147483647',
            display: 'none',
            overflow: 'hidden',
            background: 'white',
            transition: 'opacity 0.3s ease'
        });

        // Create drag handle overlay for the header (leave space for close button)
        const dragHandle = document.createElement('div');
        Object.assign(dragHandle.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            right: '40px', // Leave space for close button on the right
            height: '48px',
            cursor: 'grab',
            zIndex: '3',
            background: 'transparent'
        });
        container.appendChild(dragHandle);

        // Create iframe for chat
        const iframe = document.createElement('iframe');
        iframe.src = chrome.runtime.getURL('chat-widget.html');
        Object.assign(iframe.style, {
            width: '100%',
            height: '100%',
            border: 'none',
            borderRadius: '12px',
            position: 'relative',
            zIndex: '1'
        });

        container.appendChild(iframe);

        // Create resize handles
        const resizeHandles = createResizeHandles(container);
        resizeHandles.forEach(handle => container.appendChild(handle));

        document.body.appendChild(container);

        chatWidget = container;

        // Setup direct dragging on the drag handle
        setupDirectDragging(container, dragHandle);

        // Setup resizing
        setupResizing(container, resizeHandles);

        // Listen for messages from iframe
        window.addEventListener('message', handleWidgetMessage);

        return container;
    }

    // Create resize handles for edges
    function createResizeHandles(container) {
        const handles = [];
        const handleSize = 6;

        // Right edge handle
        const rightHandle = document.createElement('div');
        Object.assign(rightHandle.style, {
            position: 'absolute',
            top: '48px',
            right: '0',
            width: `${handleSize}px`,
            height: 'calc(100% - 48px)',
            cursor: 'ew-resize',
            background: 'transparent',
            zIndex: '3',
            transition: 'background 0.2s'
        });
        rightHandle.dataset.edge = 'right';
        rightHandle.addEventListener('mouseenter', () => {
            rightHandle.style.background = 'rgba(45, 90, 160, 0.2)';
        });
        rightHandle.addEventListener('mouseleave', () => {
            rightHandle.style.background = 'transparent';
        });
        handles.push(rightHandle);

        // Bottom edge handle
        const bottomHandle = document.createElement('div');
        Object.assign(bottomHandle.style, {
            position: 'absolute',
            bottom: '0',
            left: '0',
            width: '100%',
            height: `${handleSize}px`,
            cursor: 'ns-resize',
            background: 'transparent',
            zIndex: '3',
            transition: 'background 0.2s'
        });
        bottomHandle.dataset.edge = 'bottom';
        bottomHandle.addEventListener('mouseenter', () => {
            bottomHandle.style.background = 'rgba(45, 90, 160, 0.2)';
        });
        bottomHandle.addEventListener('mouseleave', () => {
            bottomHandle.style.background = 'transparent';
        });
        handles.push(bottomHandle);

        // Left edge handle
        const leftHandle = document.createElement('div');
        Object.assign(leftHandle.style, {
            position: 'absolute',
            top: '48px',
            left: '0',
            width: `${handleSize}px`,
            height: 'calc(100% - 48px)',
            cursor: 'ew-resize',
            background: 'transparent',
            zIndex: '3',
            transition: 'background 0.2s'
        });
        leftHandle.dataset.edge = 'left';
        leftHandle.addEventListener('mouseenter', () => {
            leftHandle.style.background = 'rgba(45, 90, 160, 0.2)';
        });
        leftHandle.addEventListener('mouseleave', () => {
            leftHandle.style.background = 'transparent';
        });
        handles.push(leftHandle);

        // Top edge handle (below header)
        const topHandle = document.createElement('div');
        Object.assign(topHandle.style, {
            position: 'absolute',
            top: '48px',
            left: '0',
            width: '100%',
            height: `${handleSize}px`,
            cursor: 'ns-resize',
            background: 'transparent',
            zIndex: '3',
            transition: 'background 0.2s'
        });
        topHandle.dataset.edge = 'top';
        topHandle.addEventListener('mouseenter', () => {
            topHandle.style.background = 'rgba(45, 90, 160, 0.2)';
        });
        topHandle.addEventListener('mouseleave', () => {
            topHandle.style.background = 'transparent';
        });
        handles.push(topHandle);

        // Bottom-right corner handle for diagonal resizing
        const cornerHandle = document.createElement('div');
        Object.assign(cornerHandle.style, {
            position: 'absolute',
            bottom: '0',
            right: '0',
            width: '16px',
            height: '16px',
            cursor: 'nwse-resize',
            background: 'linear-gradient(135deg, transparent 50%, rgba(45, 90, 160, 0.3) 50%)',
            borderBottomRightRadius: '12px',
            zIndex: '4',
            transition: 'background 0.2s'
        });
        cornerHandle.dataset.edge = 'corner';
        cornerHandle.addEventListener('mouseenter', () => {
            cornerHandle.style.background = 'linear-gradient(135deg, transparent 50%, rgba(45, 90, 160, 0.5) 50%)';
        });
        cornerHandle.addEventListener('mouseleave', () => {
            cornerHandle.style.background = 'linear-gradient(135deg, transparent 50%, rgba(45, 90, 160, 0.3) 50%)';
        });
        handles.push(cornerHandle);

        return handles;
    }

    // Setup resizing on edges
    function setupResizing(container, handles) {
        let isResizing = false;
        let currentEdge = null;
        let startX, startY, startWidth, startHeight, startBottom, startRight;

        handles.forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                currentEdge = handle.dataset.edge;
                startX = e.clientX;
                startY = e.clientY;

                // Get current dimensions and position
                const rect = container.getBoundingClientRect();
                startWidth = rect.width;
                startHeight = rect.height;

                const computedStyle = window.getComputedStyle(container);
                startBottom = parseInt(computedStyle.bottom) || 0;
                startRight = parseInt(computedStyle.right) || 0;

                // Disable iframe pointer events during resize
                const iframe = container.querySelector('iframe');
                if (iframe) {
                    iframe.style.pointerEvents = 'none';
                }

                e.preventDefault();
                e.stopPropagation();
            });
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            const minWidth = 320;
            const minHeight = 400;
            const maxWidth = 800;
            const maxHeight = window.innerHeight * 0.9;

            if (currentEdge === 'right') {
                // Drag right = grow right, drag left = shrink from right
                const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
                const widthDiff = newWidth - startWidth;
                container.style.width = `${newWidth}px`;
                // Adjust right position so the right edge moves with cursor
                container.style.right = `${startRight - widthDiff}px`;
            }
            else if (currentEdge === 'left') {
                // Drag left = grow left, drag right = shrink from left (mirror of right edge)
                const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth - deltaX));
                const widthDiff = newWidth - startWidth;
                container.style.width = `${newWidth}px`;
                // Adjust right position so the left edge moves with cursor (opposite of right edge)
                container.style.right = `${startRight - widthDiff}px`;
            }
            else if (currentEdge === 'bottom') {
                // Drag down = grow down, drag up = shrink from bottom
                const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
                const heightDiff = newHeight - startHeight;
                container.style.height = `${newHeight}px`;
                // Adjust bottom position so bottom edge moves but top edge stays fixed
                container.style.bottom = `${startBottom - heightDiff}px`;
            }
            else if (currentEdge === 'top') {
                // Drag up = grow up, drag down = shrink from top
                const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight - deltaY));
                container.style.height = `${newHeight}px`;
                // Keep bottom position fixed (widget grows/shrinks upward naturally)
            }
            else if (currentEdge === 'corner') {
                // Diagonal resize: combine right edge + bottom edge logic
                // Resize width (right edge)
                const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
                const widthDiff = newWidth - startWidth;
                container.style.width = `${newWidth}px`;
                container.style.right = `${startRight - widthDiff}px`;

                // Resize height (bottom edge)
                const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
                const heightDiff = newHeight - startHeight;
                container.style.height = `${newHeight}px`;
                container.style.bottom = `${startBottom - heightDiff}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                currentEdge = null;

                // Re-enable iframe pointer events
                const iframe = container.querySelector('iframe');
                if (iframe) {
                    iframe.style.pointerEvents = 'auto';
                }
            }
        });
    }

    // Direct dragging without iframe messaging
    function setupDirectDragging(container, dragHandle) {
        let isDragging = false;
        let startX, startY, startBottom, startRight;

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            // Get current position
            const computedStyle = window.getComputedStyle(container);
            startBottom = parseInt(computedStyle.bottom) || 0;
            startRight = parseInt(computedStyle.right) || 0;

            dragHandle.style.cursor = 'grabbing';

            // Disable iframe pointer events during drag
            const iframe = container.querySelector('iframe');
            if (iframe) {
                iframe.style.pointerEvents = 'none';
            }

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = startX - e.clientX;
            const deltaY = startY - e.clientY;

            const newRight = startRight + deltaX;
            const newBottom = startBottom + deltaY;

            // Clamp to screen bounds
            const maxRight = window.innerWidth - container.offsetWidth;
            const maxBottom = window.innerHeight - container.offsetHeight;

            const clampedRight = Math.max(0, Math.min(newRight, maxRight));
            const clampedBottom = Math.max(0, Math.min(newBottom, maxBottom));

            container.style.right = `${clampedRight}px`;
            container.style.bottom = `${clampedBottom}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                dragHandle.style.cursor = 'grab';

                // Re-enable iframe pointer events
                const iframe = container.querySelector('iframe');
                if (iframe) {
                    iframe.style.pointerEvents = 'auto';
                }
            }
        });
    }

    // Handle messages from chat widget
    function handleWidgetMessage(event) {
        if (event.data.type === 'CHANVAS_CLOSE_CHAT') {
            toggleChat();
        }
    }

    // Toggle chat visibility
    function toggleChat() {
        if (!chatWidget) {
            createChatWidget();
        }

        const isVisible = chatWidget.style.display !== 'none';

        if (isVisible) {
            // Hide chat
            chatWidget.style.opacity = '0';
            setTimeout(() => {
                chatWidget.style.display = 'none';
            }, 300);
            chatButton.innerHTML = '💬';
            chatButton.title = 'Open Chanvas Chat';
        } else {
            // Show chat
            chatWidget.style.display = 'block';
            setTimeout(() => {
                chatWidget.style.opacity = '1';
            }, 10);
            chatButton.innerHTML = '✕';
            chatButton.title = 'Close Chanvas Chat';
        }
    }


    // Initialize
    function init() {
        // Only inject on Canvas pages
        if (!window.location.hostname.includes('canvas')) {
            console.log('[CHANVAS CHAT] Not on Canvas page, skipping injection');
            return;
        }

        console.log('[CHANVAS CHAT] Initializing chat button');
        createChatButton();

        // Check if RAG data exists
        chrome.storage.local.get(['ragIndex'], (result) => {
            if (!result.ragIndex || !result.ragIndex.chunks) {
                console.log('[CHANVAS CHAT] No RAG index found');
                // Add indicator on button
                chatButton.style.opacity = '0.6';
                chatButton.title = 'Chanvas Chat (No course data - please scrape first)';
            } else {
                console.log('[CHANVAS CHAT] RAG index found:', result.ragIndex.chunks.length, 'chunks');
            }
        });
    }

    // Run initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
