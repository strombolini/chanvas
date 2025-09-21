.PHONY: venv chunks clear-db

venv:
	python3 -m venv venv
	./venv/bin/pip install -r requirements.txt

chunks:
	@python3 -c "import sqlite3; conn = sqlite3.connect('local.db'); cursor = conn.cursor(); cursor.execute('SELECT c.id, c.document_id, LENGTH(c.text) as text_length, SUBSTR(c.text, 1, 100) as text_preview, d.user_id, d.created_at FROM chunks c JOIN documents d ON c.document_id = d.id ORDER BY d.created_at DESC'); chunks = cursor.fetchall(); print(f'Total chunks: {len(chunks)}'); [print(f'Chunk {i+1}:\\n  ID: {chunk_id[:12]}...\\n  Document: {doc_id[:12]}...\\n  User: {user_id}\\n  Created: {created_at}\\n  Text length: {text_len} characters\\n  Preview: {preview}...\\n') for i, (chunk_id, doc_id, text_len, preview, user_id, created_at) in enumerate(chunks)]; cursor.execute('SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL'); print(f'Chunks with embeddings: {cursor.fetchone()[0]}'); conn.close()"

clear-db:
	@echo "Clearing database..."
	@python3 -c "import sqlite3; conn = sqlite3.connect('local.db'); cursor = conn.cursor(); cursor.execute('SELECT name FROM sqlite_master WHERE type=\"table\"'); tables = cursor.fetchall(); print('Before clearing:'); [print(f'  {table[0]}: {cursor.execute(f\"SELECT COUNT(*) FROM {table[0]}\").fetchone()[0]} records') for table in tables]; [cursor.execute(f'DELETE FROM {table[0]}') for table in tables]; conn.commit(); print('\\nAfter clearing:'); [print(f'  {table[0]}: {cursor.execute(f\"SELECT COUNT(*) FROM {table[0]}\").fetchone()[0]} records') for table in tables]; conn.close(); print('\\nDatabase cleared successfully!')"