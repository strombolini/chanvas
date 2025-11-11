// RAG (Retrieval-Augmented Generation) system for Chrome extension
// Minimal fix: move large index payloads from chrome.storage.local to IndexedDB

class ExtensionRAG {
    constructor() {
        this.EMBED_MODEL = 'text-embedding-3-small';
        this.CHUNK_SIZE = 500; // words per chunk (approximate)
        this.TOP_K = 5;        // number of chunks to retrieve
        this.OPENAI_API_KEY = null;

        // IndexedDB config
        this.IDB_NAME = 'RAGIndexDB';
        this.IDB_STORE = 'kv';
        this._idb = null;
    }

    // ---------- IndexedDB helpers (minimal, no external deps) ----------
    async idbOpen() {
        if (this._idb) return this._idb;
        this._idb = await new Promise((resolve, reject) => {
            const req = indexedDB.open(this.IDB_NAME, 1);
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains(this.IDB_STORE)) {
                    db.createObjectStore(this.IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._idb;
    }

    async idbSet(key, value) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([this.IDB_STORE], 'readwrite');
            const store = tx.objectStore(this.IDB_STORE);
            const req = store.put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async idbGet(key) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([this.IDB_STORE], 'readonly');
            const store = tx.objectStore(this.IDB_STORE);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async idbDelete(key) {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([this.IDB_STORE], 'readwrite');
            const store = tx.objectStore(this.IDB_STORE);
            const req = store.delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async idbClearAll() {
        const db = await this.idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([this.IDB_STORE], 'readwrite');
            const store = tx.objectStore(this.IDB_STORE);
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // ---------- chrome.storage helpers with error checks ----------
    storageLocalSet(obj) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set(obj, () => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                resolve();
            });
        });
    }
    storageLocalGet(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get(keys, (result) => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                resolve(result);
            });
        });
    }
    storageLocalRemove(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.remove(keys, () => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                resolve();
            });
        });
    }

    // ---------- Original methods (unchanged signatures) ----------
    async init() {
        const result = await new Promise((resolve) => {
            chrome.storage.sync.get(['openaiApiKey', 'chanvasUrl'], (data) => {
                resolve(data);
            });
        });

        this.OPENAI_API_KEY = result.openaiApiKey;
        this.chanvasUrl = result.chanvasUrl || 'http://localhost:8000';

        console.log('[RAG] Init - API key present:', !!this.OPENAI_API_KEY);

        if (!this.OPENAI_API_KEY) {
            console.error('[RAG] OpenAI API key not configured. Please set it in the extension popup.');
        }
    }

    cosineSimilarity(a, b) {
        let dot = 0.0, normA = 0.0, normB = 0.0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const ai = a[i], bi = b[i];
            dot += ai * bi;
            normA += ai * ai;
            normB += bi * bi;
        }
        if (normA === 0.0 || normB === 0.0) return 0.0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    chunkText(text, chunkSize = 500) {
        const words = text.split(/\s+/);
        const chunks = [];
        for (let i = 0; i < words.length; i += chunkSize) {
            const chunk = words.slice(i, i + chunkSize).join(' ');
            if (chunk.trim()) chunks.push(chunk);
        }
        return chunks;
    }

    async getEmbedding(text) {
        if (!this.OPENAI_API_KEY) throw new Error('OpenAI API key not configured');
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model: this.EMBED_MODEL, input: text })
        });
        if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
        const data = await response.json();
        return data.data[0].embedding;
    }

    async getEmbeddings(texts) {
        if (!this.OPENAI_API_KEY) throw new Error('OpenAI API key not configured');
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model: this.EMBED_MODEL, input: texts })
        });
        if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
        const data = await response.json();
        return data.data.map(item => item.embedding);
    }

    // --------- MINIMAL FIX APPLIED HERE: persist big arrays in IndexedDB ----------
    async indexScrapedData(coursesData) {
        console.log('[RAG] Indexing scraped data...');
        await this.init();
        if (!this.OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured. Please set it in the extension popup settings.');
        }

        // First, generate an executive summary of all course data
        console.log('[RAG] Generating executive summary...');
        const allContent = [];
        for (const courseId in coursesData) {
            const course = coursesData[courseId];
            let courseContent = `Course: ${course.name} (ID: ${courseId})\n\n`;
            for (const pageName in course.pages) {
                const page = course.pages[pageName];
                courseContent += `\n=== ${pageName.toUpperCase()} ===\n`;
                courseContent += page.content;
                courseContent += '\n\n';
            }
            allContent.push(courseContent);
        }
        
        // Combine all content for summary (limit to avoid token limits)
        const combinedContent = allContent.join('\n\n---\n\n');
        const summaryText = combinedContent.length > 200000 ? combinedContent.substring(0, 200000) + '...' : combinedContent;
        
        // Generate executive summary using GPT
        let executiveSummary = '';
        try {
            const summaryResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are creating an executive summary of Canvas course materials. Create a brief, comprehensive overview of all courses, their key topics, important assignments, deadlines, and syllabi content. Keep it under 500 words but include all critical information.'
                        },
                        {
                            role: 'user',
                            content: `Create an executive summary of the following Canvas course materials:\n\n${summaryText}`
                        }
                    ],
                    temperature: 0.3,
                    max_tokens: 800
                })
            });
            
            if (summaryResponse.ok) {
                const summaryData = await summaryResponse.json();
                executiveSummary = summaryData.choices[0].message.content;
                console.log('[RAG] Executive summary generated');
            } else {
                console.warn('[RAG] Failed to generate executive summary, continuing without it');
                executiveSummary = `Overview: ${Object.keys(coursesData).length} courses scraped with course materials.`;
            }
        } catch (e) {
            console.warn('[RAG] Error generating executive summary:', e);
            executiveSummary = `Overview: ${Object.keys(coursesData).length} courses scraped with course materials.`;
        }

        const chunks = [];
        const chunkMetadata = [];

        // Add executive summary as first chunk (always retrieved for context)
        chunks.push(`EXECUTIVE SUMMARY OF ALL COURSE MATERIALS:\n\n${executiveSummary}`);
        chunkMetadata.push({
            courseId: '_executive_summary',
            courseName: 'Executive Summary',
            chunkIndex: 0,
            totalChunks: 1,
            isExecutiveSummary: true
        });

        // Then add all course chunks
        for (let i = 0; i < allContent.length; i++) {
            const courseId = Object.keys(coursesData)[i];
            const course = coursesData[courseId];
            const courseChunks = this.chunkText(allContent[i], this.CHUNK_SIZE);
            courseChunks.forEach((chunk, index) => {
                chunks.push(chunk);
                chunkMetadata.push({
                    courseId,
                    courseName: course.name,
                    chunkIndex: index,
                    totalChunks: courseChunks.length,
                    isExecutiveSummary: false
                });
            });
        }

        console.log(`[RAG] Created ${chunks.length} chunks (1 executive summary + ${chunks.length - 1} course chunks) from ${Object.keys(coursesData).length} courses`);

        const batchSize = 100;
        const allEmbeddings = [];
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, Math.min(i + batchSize, chunks.length));
            console.log(`[RAG] Generating embeddings for chunks ${i + 1}-${Math.min(i + batchSize, chunks.length)}...`);
            const batchEmbeddings = await this.getEmbeddings(batch);
            allEmbeddings.push(...batchEmbeddings);
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Store heavy arrays in IndexedDB; light meta in chrome.storage.local
        const idPrefix = `ragIndex:default:`; // scope for this single corpus
        await this.idbSet(`${idPrefix}chunks`, chunks);
        await this.idbSet(`${idPrefix}embeddings`, allEmbeddings);
        await this.idbSet(`${idPrefix}metadata`, chunkMetadata);

        const meta = {
            backend: 'idb',
            keyPrefix: idPrefix,
            chunkCount: chunks.length,
            indexedAt: Date.now()
        };

        await this.storageLocalSet({ ragIndexMeta: meta });

        // Optional: remove legacy monolithic key if present
        await this.storageLocalRemove(['ragIndex']).catch(() => {});

        console.log(`[RAG] Indexed ${chunks.length} chunks with embeddings (stored in IndexedDB)`);
        return { chunksCount: chunks.length, indexedAt: meta.indexedAt };
    }

    async _loadIndexAny() {
        // Prefer new IDB-based meta; fall back to legacy ragIndex object if present
        const { ragIndexMeta, ragIndex } = await this.storageLocalGet(['ragIndexMeta', 'ragIndex']);

        if (ragIndexMeta && ragIndexMeta.backend === 'idb') {
            const { keyPrefix } = ragIndexMeta;
            const [chunks, embeddings, metadata] = await Promise.all([
                this.idbGet(`${keyPrefix}chunks`),
                this.idbGet(`${keyPrefix}embeddings`),
                this.idbGet(`${keyPrefix}metadata`)
            ]);
            if (!chunks || !embeddings || !metadata) {
                console.warn('[RAG] IDB meta found but data missing; falling back to legacy if available.');
            } else {
                return { chunks, embeddings, metadata, indexedAt: ragIndexMeta.indexedAt, backend: 'idb' };
            }
        }

        if (ragIndex && ragIndex.embeddings) {
            console.warn('[RAG] Using legacy in-chrome.storage index (may be size-limited).');
            return {
                chunks: ragIndex.chunks,
                embeddings: ragIndex.embeddings,
                metadata: ragIndex.metadata,
                indexedAt: ragIndex.indexedAt,
                backend: 'storage'
            };
        }

        return null;
    }

    async retrieveContext(query, topK = null) {
        if (topK === null) topK = this.TOP_K;
        console.log(`[RAG] Retrieving context for query: "${query.substring(0, 50)}..."`);

        const rag = await this._loadIndexAny();
        if (!rag || !rag.embeddings) {
            console.warn('[RAG] No indexed data found. Please index data first.');
            return { context: '', chunks: [], metadata: [] };
        }

        // Get embedding for the query
        const queryEmbedding = await this.getEmbedding(query);

        // Calculate similarity scores for all chunks
        const scores = [];
        for (let i = 0; i < rag.embeddings.length; i++) {
            const sim = this.cosineSimilarity(queryEmbedding, rag.embeddings[i]);
            scores.push({
                index: i,
                similarity: sim,
                chunk: rag.chunks[i],
                metadata: rag.metadata[i]
            });
        }

        scores.sort((a, b) => b.similarity - a.similarity);
        
        // ALWAYS include executive summary if available (it's chunk index 0)
        const executiveSummaryItem = scores.find(s => s.metadata && s.metadata.isExecutiveSummary);
        const top = scores.slice(0, topK);
        
        // If executive summary exists and isn't already in top results, add it
        if (executiveSummaryItem && !top.find(item => item.metadata && item.metadata.isExecutiveSummary)) {
            top.unshift(executiveSummaryItem);
        }

        console.log(`[RAG] Retrieved ${top.length} relevant chunks${executiveSummaryItem ? ' (including executive summary)' : ''}`);
        console.log(`[RAG] Top similarity scores:`, top.map(c => c.similarity.toFixed(3)));

        const context = top.map(item => item.chunk).join('\n\n---\n\n');
        return {
            context,
            chunks: top.map(item => item.chunk),
            metadata: top.map(item => item.metadata),
            scores: top.map(item => item.similarity)
        };
    }

    async answerWithRAG(question, chatHistory = []) {
        await this.init();
        const { context, chunks, metadata, scores } = await this.retrieveContext(question);

        if (!context) {
            return {
                answer: 'No course data available. Please scrape your Canvas courses first.',
                chunks: [],
                metadata: [],
                scores: []
            };
        }

        let historyContext = '';
        if (chatHistory.length > 0) {
            const recentHistory = chatHistory.slice(-4);
            historyContext = '\n\nRecent conversation:\n' + recentHistory.map(msg =>
                `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
            ).join('\n');
        }

        const systemPrompt = `You are a helpful Canvas course assistant. Answer the user's question based on the provided course materials.

Math formatting rules (MANDATORY):
• Use LaTeX delimiters: inline math with \\( ... \\), display math with \\[ ... \\].
• Do NOT use Unicode subscripts/superscripts (e.g., T₀). Write T_{0}, S^{*}, etc.
• Use \\ln, \\exp, \\Delta, etc. Avoid plain 'ln', 'Δ' if they appear in math.

Be concise and accurate. If the information is not in the provided context, say so.${historyContext}`;

        const userMessage = `Course Materials:\n\n${context}\n\n===QUESTION===\n${question}`;

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4-turbo-preview',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ],
                    temperature: 0.3,
                    max_tokens: 2000
                })
            });

            if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
            const data = await response.json();
            const answer = data.choices[0].message.content;

            return {
                answer,
                chunks,
                metadata,
                scores,
                usage: data.usage
            };
        } catch (error) {
            console.error('[RAG] Error generating answer:', error);
            throw error;
        }
    }

    async clearIndex() {
        // Clear both legacy and new storage
        await Promise.allSettled([
            this.storageLocalRemove(['ragIndex', 'ragIndexMeta']),
            this.idbClearAll()
        ]);
        console.log('[RAG] Index cleared (storage + IndexedDB)');
    }

    async getIndexStats() {
        const { ragIndexMeta, ragIndex } = await this.storageLocalGet(['ragIndexMeta', 'ragIndex']);

        if (ragIndexMeta && ragIndexMeta.backend === 'idb') {
            return {
                indexed: true,
                chunkCount: ragIndexMeta.chunkCount || 0,
                indexedAt: new Date(ragIndexMeta.indexedAt).toLocaleString(),
            };
        }

        if (ragIndex && ragIndex.chunks) {
            return {
                indexed: true,
                chunkCount: ragIndex.chunks.length,
                indexedAt: ragIndex.indexedAt ? new Date(ragIndex.indexedAt).toLocaleString() : null,
            };
        }

        return { indexed: false, chunkCount: 0, indexedAt: null };
    }
}

// Make it available globally (works in both service workers and content scripts)
if (typeof window !== 'undefined') {
    window.ExtensionRAG = ExtensionRAG;
}
if (typeof globalThis !== 'undefined') {
    globalThis.ExtensionRAG = ExtensionRAG;
}
