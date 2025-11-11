// PDF Content Extractor

class PDFExtractor {
  constructor() {
    this.extractedPDFs = new Set();
  }
  
  // Main extraction method - tries multiple strategies
  async extractPDFContent(url) {
    log(`Extracting PDF content from: ${url}`);
    
    // Strategy 1: Extract from Canvas viewer
    try {
      const viewerContent = await this.extractFromCanvasViewer();
      if (viewerContent && viewerContent.length > 100) {
        log('✅ Extracted PDF from Canvas viewer');
        return viewerContent;
      }
    } catch (e) {
      log('Canvas viewer extraction failed: ' + e.message);
    }
    
    // Strategy 2: Extract from iframe
    try {
      const iframeContent = await this.extractFromIframe();
      if (iframeContent && iframeContent.length > 100) {
        log('✅ Extracted PDF from iframe');
        return iframeContent;
      }
    } catch (e) {
      log('Iframe extraction failed: ' + e.message);
    }
    
    // Strategy 3: Get download link and extract metadata
    try {
      const downloadLink = this.findDownloadLink();
      if (downloadLink) {
        log(`📥 PDF download link found: ${downloadLink}`);
        return `[PDF File: ${url}]\nDownload Link: ${downloadLink}\n\nNote: Full text extraction requires downloading the PDF.`;
      }
    } catch (e) {
      log('Download link not found: ' + e.message);
    }
    
    // Strategy 4: Extract any visible text on the page
    try {
      const pageText = this.extractVisibleText();
      if (pageText && pageText.length > 50) {
        log('✅ Extracted visible text from PDF page');
        return pageText;
      }
    } catch (e) {
      log('Visible text extraction failed: ' + e.message);
    }
    
    return `[PDF File: ${url}]\n\nUnable to extract text content automatically. Please download manually if needed.`;
  }
  
  // Extract from Canvas's built-in PDF viewer
  async extractFromCanvasViewer() {
    // Look for Canvas PDF viewer elements
    const viewerSelectors = [
      'iframe[src*="pdf"]',
      'iframe[src*="file_preview"]',
      '.pdf-viewer',
      '[class*="PdfViewer"]',
      'embed[type="application/pdf"]',
      'object[type="application/pdf"]'
    ];
    
    let viewer = null;
    for (const selector of viewerSelectors) {
      viewer = document.querySelector(selector);
      if (viewer) break;
    }
    
    if (!viewer) {
      throw new Error('PDF viewer not found');
    }
    
    // If it's an iframe, try to access its content
    if (viewer.tagName === 'IFRAME') {
      try {
        const iframeDoc = viewer.contentDocument || viewer.contentWindow.document;
        if (iframeDoc) {
          // Scroll the iframe content
          await this.scrollIframeContent(viewer);
          
          // Extract text from iframe
          return this.extractTextFromDocument(iframeDoc);
        }
      } catch (e) {
        // Cross-origin iframe, can't access content
        log('Cannot access iframe content (cross-origin)');
      }
    }
    
    // Try to find text layers (PDF.js style)
    const textLayers = document.querySelectorAll('.textLayer, [class*="text-layer"], .pdf-text');
    if (textLayers.length > 0) {
      let fullText = '';
      textLayers.forEach((layer, index) => {
        const text = layer.textContent || layer.innerText;
        if (text.trim()) {
          fullText += `\n--- Page ${index + 1} ---\n${text.trim()}\n`;
        }
      });
      return fullText;
    }
    
    throw new Error('No text content found in viewer');
  }
  
  // Scroll iframe content to load all pages
  async scrollIframeContent(iframe) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      const iframeBody = iframeDoc.body || iframeDoc.documentElement;
      
      // Find scrollable element within iframe
      const scrollable = findScrollableElements.call({ document: iframeDoc });
      
      for (const item of scrollable) {
        await scrollToBottom(item.element, { delay: 500 });
      }
      
      // Also scroll the iframe body itself
      if (iframeBody.scrollHeight > iframeBody.clientHeight) {
        await scrollToBottom(iframeBody, { delay: 500 });
      }
    } catch (e) {
      log('Failed to scroll iframe: ' + e.message);
    }
  }
  
  // Extract from iframe
  async extractFromIframe() {
    const iframes = document.querySelectorAll('iframe');
    
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc) {
          const text = this.extractTextFromDocument(iframeDoc);
          if (text && text.length > 100) {
            return text;
          }
        }
      } catch (e) {
        // Cross-origin, skip
        continue;
      }
    }
    
    throw new Error('No accessible iframe found');
  }
  
  // Extract text from document
  extractTextFromDocument(doc) {
    // Remove scripts and styles
    const clone = doc.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
    
    // Try to find text layers first (PDF.js)
    const textLayers = clone.querySelectorAll('.textLayer, [class*="text-layer"]');
    if (textLayers.length > 0) {
      let text = '';
      textLayers.forEach((layer, index) => {
        text += `\n--- Page ${index + 1} ---\n${layer.textContent}\n`;
      });
      return text;
    }
    
    // Otherwise get all text
    return clone.textContent || clone.innerText || '';
  }
  
  // Find download link for PDF
  findDownloadLink() {
    const downloadSelectors = [
      'a[href*="download"]',
      'a[download]',
      'button[class*="download"]',
      '.download-link',
      'a[href*="verifier"]' // Canvas download links often have verifier param
    ];
    
    for (const selector of downloadSelectors) {
      const links = document.querySelectorAll(selector);
      for (const link of links) {
        const href = link.href;
        if (href && (href.includes('.pdf') || href.includes('/files/'))) {
          return href;
        }
      }
    }
    
    // Try to find download link in page
    const allLinks = document.querySelectorAll('a[href]');
    for (const link of allLinks) {
      const text = link.textContent.toLowerCase();
      const href = link.href;
      if ((text.includes('download') || link.hasAttribute('download')) && 
          (href.includes('.pdf') || href.includes('/files/'))) {
        return href;
      }
    }
    
    return null;
  }
  
  // Extract any visible text from the page
  extractVisibleText() {
    // Clone body to avoid modifying the page
    const clone = document.body.cloneNode(true);
    
    // Remove navigation, headers, footers, scripts, styles
    const removeSelectors = [
      'nav', 'header', 'footer', 'script', 'style', 'noscript',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '.navigation', '.header', '.footer', '.sidebar'
    ];
    
    removeSelectors.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });
    
    // Get text content
    let text = clone.textContent || clone.innerText || '';
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    return text;
  }
  
  // Scroll through all pages of PDF viewer
  async scrollPDFViewer() {
    log('Scrolling through PDF viewer to load all pages...');
    
    // Find the main scrollable container
    const scrollableElements = findScrollableElements();
    
    if (scrollableElements.length === 0) {
      log('No scrollable elements found');
      return;
    }
    
    // Scroll the largest scrollable element (likely the PDF viewer)
    const mainScrollable = scrollableElements[0];
    log(`Scrolling element with height ${mainScrollable.scrollHeight}px`);
    
    await scrollToBottom(mainScrollable.element, {
      stepSize: 0.5, // Scroll half a page at a time for PDFs
      delay: 800,    // Wait longer for PDF pages to render
      direction: 'vertical'
    });
    
    log('Finished scrolling PDF viewer');
    
    // Wait a bit more for final rendering
    await sleep(1000);
  }
  
  // Check if current page is a PDF viewer
  isPDFViewerPage() {
    const url = window.location.href;
    const title = document.title.toLowerCase();
    
    // Check URL
    if (url.includes('.pdf') || url.includes('/files/')) {
      return true;
    }
    
    // Check title
    if (title.includes('.pdf')) {
      return true;
    }
    
    // Check for PDF viewer elements
    const pdfElements = document.querySelectorAll(
      'iframe[src*="pdf"], ' +
      'embed[type="application/pdf"], ' +
      'object[type="application/pdf"], ' +
      '.pdf-viewer, ' +
      '[class*="PdfViewer"]'
    );
    
    return pdfElements.length > 0;
  }
  
  // Get PDF metadata
  getPDFMetadata() {
    const metadata = {
      url: window.location.href,
      title: document.title,
      filename: this.extractFilename(),
      downloadLink: this.findDownloadLink(),
      pageCount: this.estimatePageCount(),
      timestamp: formatTimestamp()
    };
    
    return metadata;
  }
  
  // Extract filename from page
  extractFilename() {
    // Try to get from title
    const title = document.title;
    if (title.includes('.pdf')) {
      return title.split(':')[0].trim();
    }
    
    // Try to get from breadcrumb or heading
    const headings = document.querySelectorAll('h1, h2, .filename, [class*="file-name"]');
    for (const heading of headings) {
      const text = heading.textContent.trim();
      if (text.includes('.pdf')) {
        return text;
      }
    }
    
    // Try to get from URL
    const urlMatch = window.location.pathname.match(/([^\/]+\.pdf)/i);
    if (urlMatch) {
      return decodeURIComponent(urlMatch[1]);
    }
    
    return 'unknown.pdf';
  }
  
  // Estimate page count
  estimatePageCount() {
    // Look for page indicators
    const pageIndicators = document.querySelectorAll(
      '[class*="page-count"], ' +
      '[class*="pageCount"], ' +
      '[aria-label*="page"]'
    );
    
    for (const indicator of pageIndicators) {
      const text = indicator.textContent || indicator.getAttribute('aria-label');
      const match = text.match(/of\s+(\d+)/i);
      if (match) {
        return parseInt(match[1]);
      }
    }
    
    // Count text layers
    const textLayers = document.querySelectorAll('.textLayer, [class*="text-layer"]');
    if (textLayers.length > 0) {
      return textLayers.length;
    }
    
    return null;
  }
  
  // Full PDF extraction workflow
  async extractFullPDF() {
    if (!this.isPDFViewerPage()) {
      log('Not a PDF viewer page');
      return null;
    }
    
    log('📄 PDF viewer detected, starting extraction...');
    
    // Get metadata
    const metadata = this.getPDFMetadata();
    log(`PDF: ${metadata.filename}`);
    
    // Scroll through all pages
    await this.scrollPDFViewer();
    
    // Extract content
    const content = await this.extractPDFContent(metadata.url);
    
    // Combine metadata and content
    const result = {
      type: 'pdf',
      metadata: metadata,
      content: content,
      extracted: true,
      timestamp: formatTimestamp()
    };
    
    log(`✅ PDF extraction complete: ${content.length} characters`);
    
    return result;
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDFExtractor;
}
