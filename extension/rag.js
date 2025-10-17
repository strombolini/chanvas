// RAG (Retrieval-Augmented Generation) system for Chrome extension
// Uses semantic search to find relevant chunks instead of loading all data

class ExtensionRAG {
    constructor() {
        this.EMBED_MODEL = 'text-embedding-3-small';
        this.CHUNK_SIZE = 500; // tokens per chunk (approximate)
        this.TOP_K = 5; // number of chunks to retrieve
        this.OPENAI_API_KEY = null;
    }

    // Initialize with OpenAI API key
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

    // Cosine similarity between two vectors
    cosineSimilarity(a, b) {
        let dot = 0.0;
        let normA = 0.0;
        let normB = 0.0;

        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        if (normA === 0.0 || normB === 0.0) {
            return 0.0;
        }

        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Split text into chunks (simple word-based chunking)
    chunkText(text, chunkSize = 500) {
        const words = text.split(/\s+/);
        const chunks = [];

        for (let i = 0; i < words.length; i += chunkSize) {
            const chunk = words.slice(i, i + chunkSize).join(' ');
            if (chunk.trim()) {
                chunks.push(chunk);
            }
        }

        return chunks;
    }

    // Get embedding from OpenAI API
    async getEmbedding(text) {
        if (!this.OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured');
        }

        try {
            const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.EMBED_MODEL,
                    input: text
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            return data.data[0].embedding;
        } catch (error) {
            console.error('Error getting embedding:', error);
            throw error;
        }
    }

    // Get embeddings for multiple texts (batch)
    async getEmbeddings(texts) {
        if (!this.OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured');
        }

        try {
            const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.EMBED_MODEL,
                    input: texts
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            return data.data.map(item => item.embedding);
        } catch (error) {
            console.error('Error getting embeddings:', error);
            throw error;
        }
    }

    // Process and index scraped data (run once after scraping)
    async indexScrapedData(coursesData) {
        console.log('[RAG] Indexing scraped data...');

        // Initialize to get API key
        await this.init();

        if (!this.OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured. Please set it in the extension popup settings.');
        }

        const chunks = [];
        const chunkMetadata = [];

        // Process each course
        for (const courseId in coursesData) {
            const course = coursesData[courseId];

            // Combine all page content for this course
            let courseContent = `Course: ${course.name} (ID: ${courseId})\n\n`;

            for (const pageName in course.pages) {
                const page = course.pages[pageName];
                courseContent += `\n=== ${pageName.toUpperCase()} ===\n`;
                courseContent += page.content;
                courseContent += '\n\n';
            }

            // Split into chunks
            const courseChunks = this.chunkText(courseContent, this.CHUNK_SIZE);

            // Store chunks with metadata
            courseChunks.forEach((chunk, index) => {
                chunks.push(chunk);
                chunkMetadata.push({
                    courseId: courseId,
                    courseName: course.name,
                    chunkIndex: index,
                    totalChunks: courseChunks.length
                });
            });
        }

        console.log(`[RAG] Created ${chunks.length} chunks from ${Object.keys(coursesData).length} courses`);

        // Generate embeddings for all chunks (in batches to avoid API limits)
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

        // Store indexed data in chrome.storage.local
        const indexedData = {
            chunks: chunks,
            embeddings: allEmbeddings,
            metadata: chunkMetadata,
            indexedAt: Date.now()
        };

        await chrome.storage.local.set({ ragIndex: indexedData });
        console.log(`[RAG] Indexed ${chunks.length} chunks with embeddings`);

        return indexedData;
    }

    // Retrieve relevant context for a query
    async retrieveContext(query, topK = null) {
        if (topK === null) {
            topK = this.TOP_K;
        }

        console.log(`[RAG] Retrieving context for query: "${query.substring(0, 50)}..."`);

        // Get indexed data from storage
        const result = await chrome.storage.local.get(['ragIndex']);
        const ragIndex = result.ragIndex;

        if (!ragIndex || !ragIndex.embeddings) {
            console.warn('[RAG] No indexed data found. Please index data first.');
            return { context: '', chunks: [], metadata: [] };
        }

        // Get embedding for the query
        const queryEmbedding = await this.getEmbedding(query);

        // Calculate similarity scores for all chunks
        const scores = [];
        for (let i = 0; i < ragIndex.embeddings.length; i++) {
            const similarity = this.cosineSimilarity(queryEmbedding, ragIndex.embeddings[i]);
            scores.push({
                index: i,
                similarity: similarity,
                chunk: ragIndex.chunks[i],
                metadata: ragIndex.metadata[i]
            });
        }

        // Sort by similarity (descending)
        scores.sort((a, b) => b.similarity - a.similarity);

        // Get top-k most relevant chunks
        const topChunks = scores.slice(0, topK);

        console.log(`[RAG] Retrieved ${topChunks.length} relevant chunks`);
        console.log(`[RAG] Top similarity scores:`, topChunks.map(c => c.similarity.toFixed(3)));

        // Combine chunks into context
        const context = topChunks.map(item => item.chunk).join('\n\n---\n\n');

        return {
            context: context,
            chunks: topChunks.map(item => item.chunk),
            metadata: topChunks.map(item => item.metadata),
            scores: topChunks.map(item => item.similarity)
        };
    }

    // Answer a question using retrieved context
    async answerWithRAG(question, chatHistory = []) {
        await this.init();

        // Retrieve relevant context
        const { context, chunks, metadata, scores } = await this.retrieveContext(question);

        if (!context) {
            return {
                answer: 'No course data available. Please scrape your Canvas courses first.',
                chunks: [],
                metadata: [],
                scores: []
            };
        }

        // Build chat history context
        let historyContext = '';
        if (chatHistory.length > 0) {
            const recentHistory = chatHistory.slice(-4); // Last 2 exchanges
            historyContext = '\n\nRecent conversation:\n' + recentHistory.map(msg =>
                `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
            ).join('\n');
        }

        // Create system prompt
        const systemPrompt = `You are a helpful Canvas course assistant. Answer the user's question based on the provided course materials.

Math formatting rules (MANDATORY):
• Use LaTeX delimiters: inline math with \\( ... \\), display math with \\[ ... \\].
• Do NOT use Unicode subscripts/superscripts (e.g., T₀). Write T_{0}, S^{*}, etc.
• Use \\ln, \\exp, \\Delta, etc. Avoid plain 'ln', 'Δ' if they appear in math.

Be concise and accurate. If the information is not in the provided context, say so.${historyContext}`;

        // Create user message with context
        const userMessage = `Course Materials:\n\n${context}\n\n===QUESTION===\n${question}`;

        // Call OpenAI Chat API
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

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            const answer = data.choices[0].message.content;

            return {
                answer: answer,
                chunks: chunks,
                metadata: metadata,
                scores: scores,
                usage: data.usage
            };

        } catch (error) {
            console.error('[RAG] Error generating answer:', error);
            throw error;
        }
    }

    // Clear indexed data
    async clearIndex() {
        await chrome.storage.local.remove(['ragIndex']);
        console.log('[RAG] Index cleared');
    }

    // Get index stats
    async getIndexStats() {
        const result = await chrome.storage.local.get(['ragIndex']);
        const ragIndex = result.ragIndex;

        if (!ragIndex) {
            return { indexed: false, chunkCount: 0, indexedAt: null };
        }

        return {
            indexed: true,
            chunkCount: ragIndex.chunks.length,
            indexedAt: new Date(ragIndex.indexedAt).toLocaleString(),
            courses: [...new Set(ragIndex.metadata.map(m => m.courseName))]
        };
    }
}

// Make it available globally (works in both service workers and content scripts)
if (typeof window !== 'undefined') {
    window.ExtensionRAG = ExtensionRAG;
}
// Also make it available in global scope for service workers
if (typeof globalThis !== 'undefined') {
    globalThis.ExtensionRAG = ExtensionRAG;
}
