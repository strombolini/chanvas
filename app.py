# app.py (with Test Scrape support + Fall 2025 filters + sequential queue)
import os
import signal
from zoneinfo import ZoneInfo  # stdlib IANA time zone support

import re
import json
import uuid
import time
import math
import shutil
import threading
import logging
import traceback
import contextlib
import tempfile
import datetime
from typing import List, Dict, Tuple, Optional
from flask import Flask, request, redirect, url_for, session, jsonify
from flask import send_file
import logging
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import create_engine, text as sql_text
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.exc import PendingRollbackError
from logging.handlers import RotatingFileHandler
from models import Base, User, Job, Document, Chunk
from canvas_scraper import run_canvas_scrape_job
# Optional tokenizer (true token budgeting like local scripts)
try:
    import tiktoken
except Exception:
    tiktoken = None
# HTTP for OpenAI; mirrors local compress_text.py / canvas.py style
import requests
# -----------------------------------------------------------------------------
# Flask and config
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]

# Database (normalize Heroku scheme and force sslmode=require on hosted Postgres)
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///local.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
if DATABASE_URL.startswith("postgresql://") and "sslmode=" not in DATABASE_URL and "localhost" not in DATABASE_URL:
    sep = "&" if "?" in DATABASE_URL else "?"
    DATABASE_URL = f"{DATABASE_URL}{sep}sslmode=require"
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
Base.metadata.create_all(engine)
# --- Auto-scrape model & simple encryption -----------------------------------
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.dialects.postgresql import JSONB as _JSONB  # will fallback below
import base64, hashlib
try:
    JSONB = _JSONB
except Exception:
    from sqlalchemy.types import JSON as JSONB
gunicorn_error_logger = logging.getLogger("gunicorn.error")
app.logger.handlers = gunicorn_error_logger.handlers
app.logger.setLevel(gunicorn_error_logger.level)
class AutoScrape(Base):
    __tablename__ = "auto_scrapes"
    id = Column(String(32), primary_key=True)           # uuid hex for record
    user_id = Column(Integer, unique=True, index=True)  # one-per-user
    enabled = Column(Boolean, default=False, nullable=False)
    username = Column(String(255))                      # last Canvas username used
    password_enc = Column(String(4096))                 # encrypted Canvas password
    headless = Column(Boolean, default=True, nullable=False)
    cookies_json = Column(String)                       # reserved for future cookie reuse
    next_run_at = Column(DateTime)                      # UTC next run time
    last_run_at = Column(DateTime)                      # UTC last successful run time
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

# ensure table exists even if this file loads before the earlier create_all
Base.metadata.create_all(engine)

def _fernet_key_from_secret(secret: bytes) -> bytes:
    """Derive a 32-byte urlsafe base64 key from app.secret_key or OPENAI key."""
    raw = hashlib.sha256(secret or b"default-secret").digest()
    return base64.urlsafe_b64encode(raw)

try:
    from cryptography.fernet import Fernet
    _FERNET = Fernet(_fernet_key_from_secret(
        (app.secret_key if isinstance(app.secret_key, (bytes, bytearray)) else str(app.secret_key).encode("utf-8"))
    ))
except Exception:
    _FERNET = None

def _encrypt_pw(s: str) -> str:
    if not s:
        return ""
    try:
        if _FERNET:
            return "v1:" + _FERNET.encrypt(s.encode("utf-8")).decode("utf-8")
    except Exception:
        pass
    # fallback (not strong, but better than plain)
    return "b64:" + base64.b64encode(s.encode("utf-8")).decode("utf-8")

def _decrypt_pw(s: str) -> str:
    if not s:
        return ""
    try:
        if s.startswith("v1:") and _FERNET:
            return _FERNET.decrypt(s[3:].encode("utf-8")).decode("utf-8")
        if s.startswith("b64:"):
            return base64.b64decode(s[4:].encode("utf-8")).decode("utf-8")
    except Exception:
        return ""
    return ""

SessionLocal = scoped_session(sessionmaker(bind=engine, expire_on_commit=False))
# Logging
LOG_PATH = os.environ.get("ERROR_LOG_PATH", "server_errors.log")
logger = logging.getLogger("app")
logger.setLevel(logging.INFO)
if not logger.handlers:
    fh = RotatingFileHandler(LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8")
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(threadName)s %(name)s: %(message)s")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
def log_exception(where: str, exc: Exception):
    tb = traceback.format_exc()
    logger.error("Exception at %s: %r\n%s", where, exc, tb)
@app.teardown_appcontext
def remove_session(exception=None):
    SessionLocal.remove()
def sanitize_db_text(s: str) -> str:
    if not s:
        return s
    s = s.replace("\x00", "")
    return re.sub(r"[\x01-\x08\x0B\x0C\x0E-\x1F]", "", s)
def current_user(db):
    uid = session.get("user_id")
    if not uid:
        return None
    return db.query(User).filter(User.id == uid).first()
def login_required(fn):
    import functools
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login"))
        return fn(*args, **kwargs)
    return wrapper
# -----------------------------------------------------------------------------
# Models / constants mirrored from local workflow
# -----------------------------------------------------------------------------
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
if not OPENAI_API_KEY:
    logger.warning("OPENAI_API_KEY is not set; API calls will fail.")
# Switched default chat model to gpt-4o (course chat)
CHAT_MODEL = os.environ.get("CHAT_MODEL", "gpt-4.1")
COMPRESSION_MODEL = os.environ.get("COMPRESSION_MODEL", os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"))
EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-embedding-3-small")
# Context budgeting aligned to local scripts
MODEL_CONTEXT_TOKENS = int(os.environ.get("MODEL_CONTEXT_TOKENS", "128000"))  # ~4o-mini window
DEFAULT_CHUNK_TOKENS = int(os.environ.get("DEFAULT_CHUNK_TOKENS", "30000"))   # compress_text.py default
RESERVED_TOKENS = int(os.environ.get("RESERVED_TOKENS", "4000"))              # compress step overhead
MAX_OUTPUT_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "1500"))          # legacy cap; dynamic per-chunk below
CHAT_CONTEXT_TOKENS = int(os.environ.get("CHAT_CONTEXT_TOKENS", "120000"))    # chat-side context budget
MAX_CONTEXT_CHARS = int(os.environ.get("MAX_CONTEXT_CHARS", "180000"))
RETRIEVAL_CHUNK_TOKENS = int(os.environ.get("RETRIEVAL_CHUNK_TOKENS", "1200"))  # embedding chunk size
TOP_K = int(os.environ.get("TOP_K", "12"))
CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
SUMMARIZE_CHUNK_TOKENS = int(os.environ.get("SUMMARIZE_CHUNK_TOKENS", "110000"))
SUMMARIZE_MAX_OUTPUT_TOKENS = int(os.environ.get("SUMMARIZE_MAX_OUTPUT_TOKENS", "16000"))
STREAM_OUT_DIR = os.environ.get("STREAM_OUT_DIR", "stream_out")
def _stream_file_path(user_id: int, job_id: str) -> str:
    out_dir = os.path.abspath(STREAM_OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"stream_{user_id}_{job_id}.txt")
# Live scrape stream (distinct from logs and compressed stream)
SCRAPE_STREAM_DIR = os.environ.get("SCRAPE_STREAM_DIR", "scrape_stream")

def _scrape_stream_file_path(user_id: int, job_id: str) -> str:
    out_dir = os.path.abspath(SCRAPE_STREAM_DIR)
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"scrape_{user_id}_{job_id}.txt")

def _append_scrape_stream_file(path: str, text: str) -> None:
    # Durable append for long-running scrapes
    with open(path, "a", encoding="utf-8", buffering=1) as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
# --- Persistent Selenium session/profile (keep Canvas login warm) ------------
SESSION_ROOT = os.environ.get("SESSION_ROOT", "sessions")

def _session_dir(user_id: int) -> str:
    base = os.path.abspath(SESSION_ROOT)
    os.makedirs(base, exist_ok=True)
    d = os.path.join(base, f"user_{user_id}")
    os.makedirs(d, exist_ok=True)
    return d

def _copytree(src: str, dst: str):
    # dirs_exist_ok portable copy (Py<3.8 safe)
    os.makedirs(dst, exist_ok=True)
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target_root = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(target_root, exist_ok=True)
        for d in dirs:
            os.makedirs(os.path.join(target_root, d), exist_ok=True)
        for f in files:
            sp = os.path.join(root, f)
            dp = os.path.join(target_root, f)
            with contextlib.suppress(Exception):
                shutil.copy2(sp, dp)

def _persist_session(tmp_root: str, dest: str):
    """
    Try to persist the logged-in browser profile/cookies from the scraper's tmp_root.
    We look for common subdirs if present; else we copy tmp_root entirely.
    """
    try:
        if not tmp_root or not os.path.isdir(tmp_root):
            return
        candidate = None
        for name in ("session", "profile", "browser_profile", "selenium_profile", ".profile"):
            p = os.path.join(tmp_root, name)
            if os.path.exists(p):
                candidate = p
                break
        src = candidate or tmp_root
        # refresh destination completely
        shutil.rmtree(dest, ignore_errors=True)
        _copytree(src, dest)
    except Exception as e:
        log_exception("_persist_session", e)

# File-based job logs (one file per job)
JOB_LOG_DIR = os.environ.get("JOB_LOG_DIR", "job_logs")
def _job_log_path(job_id: str) -> str:
    out_dir = os.path.abspath(JOB_LOG_DIR)
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"job_{job_id}.log")
def _append_job_log_file(job_id: str, message: str):
    ts = datetime.datetime.utcnow().strftime("%H:%M:%S")
    line = f"{ts} {message}\n"
    with open(_job_log_path(job_id), "a", encoding="utf-8") as f:
        f.write(line)
# -----------------------------------------------------------------------------
# Token helpers (ported from local)
# -----------------------------------------------------------------------------
def get_encoder(model: str):
    if tiktoken is None:
        return None
    try:
        return tiktoken.encoding_for_model(model)
    except Exception:
        try:
            return tiktoken.get_encoding("o200k_base")
        except Exception:
            return tiktoken.get_encoding("cl100k_base")
def estimate_tokens(text: str, model: str) -> int:
    enc = get_encoder(model)
    if enc is None:
        return max(1, len(text) // 4)
    try:
        return len(enc.encode(text))
    except Exception:
        return max(1, len(text) // 4)
def encode_text(text: str, model: str):
    enc = get_encoder(model)
    if enc is None:
        # fallback: 4 chars ≈ 1 token slices
        toks = []
        step = 4
        for i in range(0, len(text), step):
            toks.append(text[i:i+step])
        return toks, enc
    return enc.encode(text), enc
def decode_tokens(tokens, enc):
    if enc is None:
        return "".join(tokens)
    return enc.decode(tokens)
def truncate_to_tokens(text: str, max_tokens: int, model: str) -> str:
    if estimate_tokens(text, model) <= max_tokens:
        return text
    lo, hi = 0, len(text)
    best = ""
    while lo <= hi:
        mid = (lo + hi) // 2
        cand = text[:mid]
        t = estimate_tokens(cand, model)
        if t <= max_tokens:
            best = cand
            lo = mid + 1
        else:
            hi = mid - 1
    return best
# -----------------------------------------------------------------------------
# OpenAI helpers (shape-robust like local)
# -----------------------------------------------------------------------------
def _flatten_blocks(x) -> str:
    out = []
    def walk(v):
        if isinstance(v, str):
            if v.strip():
                out.append(v)
        elif isinstance(v, dict):
            t = v.get("type")
            if t in ("text", "output_text") and isinstance(v.get("text"), str):
                if v["text"].strip():
                    out.append(v["text"])
            else:
                for k in ("text", "content", "value", "data"):
                    if k in v and isinstance(v[k], (str, list, dict)):
                        walk(v[k])
                for val in v.values():
                    if isinstance(val, (list, dict)):
                        walk(val)
        elif isinstance(v, (list, tuple)):
            for it in v:
                walk(it)
    walk(x)
    return "\n".join(s for s in out if isinstance(s, str) and s.strip()).strip()
def extract_assistant_text(data: dict) -> str:
    try:
        if not isinstance(data, dict):
            return ""
        choices = data.get("choices") or []
        if isinstance(choices, list) and choices:
            for ch in choices:
                if not isinstance(ch, dict):
                    continue
                msg = ch.get("message")
                if isinstance(msg, dict):
                    content = msg.get("content")
                    if isinstance(content, str) and content.strip():
                        return content.strip()
                    if isinstance(content, (list, dict)):
                        flat = _flatten_blocks(content)
                        if flat:
                            return flat
        for key in ("output_text", "content", "response", "text"):
            if key in data:
                flat = _flatten_blocks(data[key])
                if flat:
                    return flat
        return _flatten_blocks(data)
    except Exception:
        return ""
def openai_chat(payload: dict, timeout: int = 180) -> str:
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
    backoff = 2.0
    for attempt in range(1, 6):
        try:
            resp = requests.post(CHAT_COMPLETIONS_URL, headers=headers, json=payload, timeout=timeout)
            if resp.status_code == 400:
                logger.warning("400 from API: %s", resp.text[:400])
            resp.raise_for_status()
            data = resp.json()
            txt = extract_assistant_text(data)
            return txt.strip() if txt else "[No content returned]"
        except requests.exceptions.HTTPError as e:
            code = getattr(e.response, "status_code", None)
            body = ""
            try:
                body = e.response.text[:800]
            except Exception:
                pass
            logger.error("OpenAI API HTTP %s: %s", code, body)
            if code in (429, 500, 502, 503, 504):
                time.sleep(backoff)
                backoff = min(30.0, backoff * 1.7)
                continue
            raise

        except requests.exceptions.RequestException:
            time.sleep(backoff)
            backoff = min(30.0, backoff * 1.7)
    return "[Error: retries exhausted]"
def openai_embed(texts: List[str]) -> List[List[float]]:
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
    payload = {"model": EMBED_MODEL, "input": texts}
    resp = requests.post(EMBEDDINGS_URL, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    vectors = []
    for item in data.get("data", []):
        vec = item.get("embedding", [])
        vectors.append(vec)
    if len(vectors) != len(texts):
        raise RuntimeError("Embedding count mismatch: got %d for %d texts" % (len(vectors), len(texts)))
    return vectors
def progressive_summarize_corpus(raw: str, job_id: str, db, 
                                 chunk_tokens: int = SUMMARIZE_CHUNK_TOKENS, 
                                 max_out_tokens: int = SUMMARIZE_MAX_OUTPUT_TOKENS) -> str:
    if not raw or not raw.strip():
        return raw
    # Use CHAT_MODEL tokenizer so budgets align with gpt-4o context
    toks, enc = encode_text(raw, CHAT_MODEL)
    total = len(toks)
    if total <= 0:
        return raw
    num_chunks = math.ceil(total / chunk_tokens)
    summaries: List[str] = []
    # Safety headroom against 128k window
    CONTEXT_LIMIT = MODEL_CONTEXT_TOKENS  # e.g., 128000 for gpt-4o
    PROMPT_HEADROOM = 1500                # system+instructions buffer
    _update_job(db, job_id, status="summarizing",
                log_line=f"First-pass summarization started: {num_chunks} chunk(s) at ~{chunk_tokens} tokens each, target ~{max_out_tokens} output tokens per chunk")
    for i in range(num_chunks):
        start = i * chunk_tokens
        end = min(total, (i + 1) * chunk_tokens)
        part_tokens = toks[start:end]
        part_text = decode_tokens(part_tokens, enc)
        # Compute a safe max output to avoid blowing the context window
        in_tokens_est = estimate_tokens(part_text, CHAT_MODEL)
        safe_max_out = max(512, min(max_out_tokens, max(512, CONTEXT_LIMIT - in_tokens_est - PROMPT_HEADROOM)))
        _update_job(db, job_id, status="summarizing",
                    log_line=f"Summarizing chunk {i+1}/{num_chunks}: ~{in_tokens_est} input tokens → up to {safe_max_out} output tokens")
        system = (
            "Summarize the following course materials, (Just because the beginning of the block you're summarizing starts with a particular course, doesn't mean it will end with it. Keep in mind that if the course information changes to a different course mid-way, you need to output a second course description for the information summarized for that course.) into a compact but detailed brief that preserves:\n"
            "- exact problem set questions and subparts when present\n"
            "- schedules, due dates, times, locations, exam windows\n"
            "- grading breakdowns, late policies, and rubrics\n"
            "- instructor/TAs, contact info, and office hours\n"
            "- assignment instructions and submission requirements\n"
            "- modules/units coverage and required readings\n"
            "- announcements, policy changes, datasets/links\n\n"
            "Keep technical notation and numbering; do not omit details that affect studying or deadlines. "
            "Prefer bullet points and short paragraphs, and end with a brief checklist of actionable next steps.\n\n"
            "For each block you're summarizing, detect which class it's most relevant to, and at the top of your summary you should output 'The user is enrolled in the following class:' along with the class number and name. then say you're starting the summary for that class.\n"
            "At the end of your summary you should say 'End of summary for the class that the user is enrolled in,' and then the class name slash number."
            "Text to summarize:\n"
        )
        user = (
            "Summarize the following course materials (Just because the beginning of the block you're summarizing starts with a particular course, doesn't mean it will end with it. Keep in mind that if the course information changes to a different course mid-way, you need to output a second course description for the information summarized for that course.) into a compact but detailed brief that preserves:\n"
            "- exact problem set questions and subparts when present\n"
            "- schedules, due dates, times, locations, exam windows\n"
            "- grading breakdowns, late policies, and rubrics\n"
            "- instructor/TAs, contact info, and office hours\n"
            "- assignment instructions and submission requirements\n"
            "- modules/units coverage and required readings\n"
            "- announcements, policy changes, datasets/links\n\n"
            "Keep technical notation and numbering; do not omit details that affect studying or deadlines. "
            "Prefer bullet points and short paragraphs, and end with a brief checklist of actionable next steps.\n\n"
            "For each block you're summarizing, detect which class it's most relevant to, and at the top of your summary you should output 'The user is enrolled in the following class:' along with the class number and name. then say you're starting the summary for that class.\n"
            "At the end of your summary you should say 'End of summary for the class that the user is enrolled in,' and then the class name slash number."
            "Text to summarize:\n"
            f"{part_text}"
        )
        payload = {
            "model": CHAT_MODEL,       # e.g., gpt-4o
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
            "max_tokens": int(safe_max_out),
        }
        summary = openai_chat(payload).strip()
        # Log a preview (truncated) to the job page
        preview = sanitize_db_text(summary[:1000])
        _update_job(db, job_id, log_line=f"Summary {i+1}/{num_chunks} preview:\n{preview}\n...")
        summaries.append(summary)
    summarized = "\n\n".join(summaries).strip()
    _update_job(db, job_id, status="summarizing", 
                log_line=f"First-pass summarization complete: {len(summarized)} chars")
    return summarized
# -----------------------------------------------------------------------------
# Compression (mirrors compress_text.py system+prompt and chunking)
#   Updated: dynamic per-chunk budget to keep final <= CHAT_CONTEXT_TOKENS
# -----------------------------------------------------------------------------
def compress_raw_text(raw: str, logger_prefix: str = "") -> str:
    if not raw.strip():
        return ""
    # Calculate token size of entire corpus
    toks, enc = encode_text(raw, COMPRESSION_MODEL)
    token_size_corpus = len(toks)
    # Base threshold
    MAX_CORPUS_TOKENS = 126000
    # Calculate compression ratio
    compression_ratio = token_size_corpus / MAX_CORPUS_TOKENS
    # Calculate chunk number (rounded up + 1)
    import math
    chunk_number = math.ceil(compression_ratio) + 1
    # Calculate chunk input size
    chunk_input_size = math.ceil(token_size_corpus / chunk_number)
    # Calculate compression percentage for each chunk
    compression_percentage_small = 1 / chunk_number
    # Logging
    logger.info(
        f"{logger_prefix}Compression: total tokens={token_size_corpus}, chunk_number={chunk_number}, "
        f"chunk_input_size={chunk_input_size}, compression_percentage={compression_percentage_small:.4f}"
    )
    compressed_out_parts = []
    # System prompt for compression
    system = (
        "You are a high-fidelity cleaner for Canvas course materials. "
        f"Compress the input text segment down to approximately "
        f"{int(compression_percentage_small * 100)}% of its original size, preserving important academic info such as times, grading policies, assignment problems, and crucial student info. "
        "For notes or less critical info, higher compression is allowed. Label the class at the start of the output."
        "Summarize the following course materials (Just because the beginning of the block you're summarizing starts with a particular course, doesn't mean it will end with it. Keep in mind that if the course information changes to a different course mid-way, you need to output a second course description for the information summarized for that course.) into a compact but detailed brief that preserves:\n"
            "- exact problem set questions and subparts when present\n"
            "- schedules, due dates, times, locations, exam windows\n"
            "- grading breakdowns, late policies, and rubrics\n"
            "- instructor/TAs, contact info, and office hours\n"
            "- assignment instructions and submission requirements\n"
            "- modules/units coverage and required readings\n"
            "- announcements, policy changes, datasets/links\n\n"
            "Keep technical notation and numbering; do not omit details that affect studying or deadlines. "
            "Prefer bullet points and short paragraphs, and end with a brief checklist of actionable next steps.\n\n"
            "For each block you're summarizing, detect which class it's most relevant to, and at the top of your summary you should output 'The user is enrolled in the following class:' along with the class number and name. then say you're starting the summary for that class.\n"
            "At the end of your summary you should say 'End of summary for the class that the user is enrolled in,' and then the class name slash number."
            "Text to summarize:\n"

    )
    # Process each chunk
    for i in range(chunk_number):
        start = i * chunk_input_size
        end = min(token_size_corpus, (i + 1) * chunk_input_size)
        chunk_tokens = toks[start:end]
        chunk_text = decode_tokens(chunk_tokens, enc)
        if not chunk_text.strip():
            continue
        # User message for compression
        user_msg = (
            f"Compress the following raw scrape segment as specified, targeting approximately "
            f"{int(compression_percentage_small * 100)}% of the original tokens. "
            f"Preserve all problem sets with questions, times, grading, instructors, and assignment details. "
            "Summarize the following course materials (Just because the beginning of the block you're summarizing starts with a particular course, doesn't mean it will end with it. Keep in mind that if the course information changes to a different course mid-way, you need to output a second course description for the information summarized for that course.) into a compact but detailed brief that preserves:\n"
            "- exact problem set questions and subparts when present\n"
            "- schedules, due dates, times, locations, exam windows\n"
            "- grading breakdowns, late policies, and rubrics\n"
            "- instructor/TAs, contact info, and office hours\n"
            "- assignment instructions and submission requirements\n"
            "- modules/units coverage and required readings\n"
            "- announcements, policy changes, datasets/links\n\n"
            "Keep technical notation and numbering; do not omit details that affect studying or deadlines. "
            "Prefer bullet points and short paragraphs, and end with a brief checklist of actionable next steps.\n\n"
            "For each block you're summarizing, detect which class it's most relevant to, and at the top of your summary you should output 'The user is enrolled in the following class:' along with the class number and name. then say you're starting the summary for that class.\n"
            "At the end of your summary you should say 'End of summary for the class that the user is enrolled in,' and then the class name slash number."
            "Text to summarize:\n" +
            chunk_text
        )
        # Create payload
        payload = {
            "model": COMPRESSION_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            "temperature": 0.0,
            "max_tokens": min(16384, int(chunk_input_size * compression_percentage_small * 1.2)),  # Use model's actual max output limit
        }
        compressed_chunk = openai_chat(payload).strip()
        # If output too long, re-run with explicit max length
        try:
            est_len = estimate_tokens(compressed_chunk, COMPRESSION_MODEL)
        except Exception:
            est_len = 0
        max_out_tokens = int(chunk_input_size * compression_percentage_small * 1.2)
        if est_len > max_out_tokens:
            payload["messages"].append({
                "role": "user",
                "content": f"The previous output exceeded the max token limit. Rewrite it to at most {max_out_tokens} tokens while preserving all key content."
            })
            compressed_chunk = openai_chat(payload).strip()
        compressed_out_parts.append(compressed_chunk)
    # Join all compressed chunks
    compressed = "\n".join(compressed_out_parts).strip()
    # Optional final truncation (gate by env var)
    if os.environ.get("COMPRESS_FINAL_TRUNCATE", "1") == "1":
        final_token_count = estimate_tokens(compressed, CHAT_MODEL)
        if final_token_count > MAX_CORPUS_TOKENS:
            logger.info(f"{logger_prefix}Final compressed text over token budget, truncating to {MAX_CORPUS_TOKENS} tokens.")
            compressed = truncate_to_tokens(compressed, MAX_CORPUS_TOKENS, CHAT_MODEL)
    return compressed
    
def _split_stream_by_course(raw: str):
    """
    Returns a list of dicts:
      {"course_id": "<id|GLOBAL>", "course_name": "<name|GLOBAL>", "text": "<segment>"}
    Splits when:
      - a different /courses/<id> URL is seen,
      - or a '[log] [course done] <id>' line is seen.
    Also captures the bracketed course label immediately before 'PAGE', e.g.:
      ... [MATH 4220_5220 Complex Analysis _2025FA_] PAGE https://canvas.cornell.edu/courses/80348 ...
    """
    parts = []
    cur_id = None
    cur_name = None
    buf = []

    course_url_re = re.compile(r"https?://[^\s)]+/courses/(\d+)")
    course_done_re = re.compile(r"\[log\]\s*\[course done\]\s*(\d+)")
    # capture the bracketed label that appears immediately before 'PAGE'
    snippet_name_re = re.compile(r"\[([^\]]+?)\]\s+PAGE\s+https?://")

    for line in raw.splitlines():
        # capture human-readable course label if present (the one right before 'PAGE')
        mname = snippet_name_re.search(line)
        if mname:
            cur_name = mname.group(1).strip()

        # detect course id from URL
        mid = course_url_re.search(line)
        if mid:
            cid = mid.group(1)
            if cur_id is None:
                cur_id = cid
            elif cid != cur_id:
                # flush previous course segment on course switch
                if buf:
                    parts.append({
                        "course_id": cur_id,
                        "course_name": cur_name or f"course {cur_id}",
                        "text": "\n".join(buf).strip()
                    })
                    buf = []
                cur_id = cid

        # accumulate
        buf.append(line)

        # explicit course end marker in logs
        mdone = course_done_re.search(line)
        if mdone and cur_id and mdone.group(1) == cur_id:
            parts.append({
                "course_id": cur_id,
                "course_name": cur_name or f"course {cur_id}",
                "text": "\n".join(buf).strip()
            })
            buf = []
            cur_id = None
            cur_name = None

    # flush trailing buffer
    if buf:
        parts.append({
            "course_id": cur_id or "GLOBAL",
            "course_name": cur_name or "GLOBAL",
            "text": "\n".join(buf).strip()
        })
    return parts

def stream_compress_corpus_blocks(raw: str, user_id: int, job_id: str, db=None,
                                  block_tokens: int = 20000,
                                  target_ratio: float = 0.5) -> str:
    """
    Course-aware streaming compression:
      - First split the live stream by Canvas course boundaries (URL /courses/<id> and [log] markers).
      - Compute a single global target ratio from total tokens across all courses (to cap ~126k).
      - Compress each course segment independently in ~block_tokens chunks, writing sequentially to the same stream file.
    Returns the absolute path to the stream file.
    """
    # Prepare output file (truncate if exists)
    stream_path = _stream_file_path(user_id, job_id)
    with open(stream_path, "w", encoding="utf-8") as f:
        f.write("")

    # Split by course
    segments = _split_stream_by_course(raw)  # [{"course_id","course_name","text"}]
    if not segments:
        return stream_path

    # Tokenize all segments to compute a global ratio
    seg_infos = []
    total_tokens = 0
    for seg in segments:
        stoks, s_enc = encode_text(seg["text"], COMPRESSION_MODEL)
        seg_infos.append({"seg": seg, "toks": stoks, "enc": s_enc})
        total_tokens += len(stoks)

    if total_tokens <= 0:
        return stream_path

    # Global ratio to target ~126k final across all courses
    target_ratio_global = min(1.0, 126000 / float(total_tokens))
    target_percent = max(1, int(target_ratio_global * 100))

    # System prompt (kept consistent)
    system = (
        "Summarize the following course materials (Just because the beginning of the block you're summarizing starts with a particular course, doesn't mean it will end with it. Keep in mind that if the course information changes to a different course mid-way, you need to output a second course description for the information summarized for that course.) into a compact but detailed brief that preserves:\n"
        "- exact problem set questions and subparts when present\n"
        "- schedules, due dates, times, locations, exam windows\n"
        "- grading breakdowns, late policies, and rubrics\n"
        "- instructor/TAs, contact info, and office hours\n"
        "- assignment instructions and submission requirements\n"
        "- modules/units coverage and required readings\n"
        "- announcements, policy changes, datasets/links\n\n"
        "Keep technical notation and numbering; do not omit details that affect studying or deadlines. "
        "Prefer bullet points and short paragraphs, and end with a brief checklist of actionable next steps.\n\n"
        "For each block you're summarizing, detect which class it's most relevant to, and at the top of your summary you should output 'The user is enrolled in the following class:' along with the class number and name. then say you're starting the summary for that class.\n"
        "At the end of your summary you should say 'End of summary for the class that the user is enrolled in,' and then the class name slash number."
        "Use the full output budget to maximize information retention. Label the class at the start of the output."
        "Text to summarize:\n"
    )

    if db is not None:
        _update_job(db, job_id, status="compressing",
                    log_line=f"Streaming compression (course-aware): segments={len(segments)}, total_tokens≈{total_tokens}, target≈{target_percent}%")

    MODEL_MAX_OUT = 16384

    # Process each course segment independently
    for idx, info in enumerate(seg_infos, 1):
        seg = info["seg"]
        toks = info["toks"]
        enc = info["enc"]
        cid = seg["course_id"]
        cname = seg["course_name"]

        # Write a visible course header into the stream for downstream clarity
        header = f"\n--- COURSE START [{cname}] (courses/{cid}) ---\n"
        with open(stream_path, "a", encoding="utf-8", buffering=1) as f:
            f.write(header)
            f.flush()
            os.fsync(f.fileno())

        # Chunk this course segment by tokens
        num_blocks = math.ceil(len(toks) / block_tokens)
        if db is not None:
            _update_job(db, job_id, status="compressing",
                        log_line=f"[{idx}/{len(seg_infos)}] Course {cid or 'GLOBAL'} '{cname}': {num_blocks} block(s) at ≈{block_tokens} tokens; target≈{target_percent}%")

        for i in range(num_blocks):
            start = i * block_tokens
            end = min(len(toks), (i + 1) * block_tokens)
            part_tokens = toks[start:end]
            part_text = decode_tokens(part_tokens, enc)
            if not part_text.strip():
                continue

            in_tokens_est = estimate_tokens(part_text, COMPRESSION_MODEL)
            target_out = int(in_tokens_est * target_ratio_global)
            max_out_tokens = min(MODEL_MAX_OUT, max(512, target_out))

            user_msg = (
                f"The following text is from course [{cname}] (courses/{cid}). "
                f"Compress this segment to ~{target_percent}% of its original tokens while preserving assignments, dates, policies, instructors, and problem statements. "
                "Summarize the following course materials (Just because the beginning of the block you're summarizing starts with a particular course, doesn't mean it will end with it. Keep in mind that if the course information changes to a different course mid-way, you need to output a second course description for the information summarized for that course.) into a compact but detailed brief that preserves:\n"
                "- exact problem set questions and subparts when present\n"
                "- schedules, due dates, times, locations, exam windows\n"
                "- grading breakdowns, late policies, and rubrics\n"
                "- instructor/TAs, contact info, and office hours\n"
                "- assignment instructions and submission requirements\n"
                "- modules/units coverage and required readings\n"
                "- announcements, policy changes, datasets/links\n\n"
                "Keep technical notation and numbering; do not omit details that affect studying or deadlines. "
                "Prefer bullet points and short paragraphs, and end with a brief checklist of actionable next steps.\n\n"
                "For each block you're summarizing, detect which class it's most relevant to, and at the top of your summary you should output 'The user is enrolled in the following class:' along with the class number and name. then say you're starting the summary for that class.\n"
                "At the end of your summary you should say 'End of summary for the class that the user is enrolled in,' and then the class name slash number."
                "Text to summarize:\n"
                f"Use up to {max_out_tokens} tokens to maximize retention.\n\n" + part_text
            )

            payload = {
                "model": COMPRESSION_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg},
                ],
                "temperature": 0.0,
                "max_tokens": int(max_out_tokens),
            }

            if db is not None:
                _update_job(db, job_id, status="compressing",
                            log_line=f"[{idx}/{len(seg_infos)}] Course {cid or 'GLOBAL'} block {i+1}/{num_blocks}: ~{in_tokens_est} in → budget {max_out_tokens} out (target≈{target_percent}%)")

            compressed_chunk = openai_chat(payload).strip()

            # Guard: re-ask if output exceeds cap (rare)
            try:
                out_est = estimate_tokens(compressed_chunk, COMPRESSION_MODEL)
            except Exception:
                out_est = 0
            if out_est > max_out_tokens:
                payload["messages"].append({
                    "role": "user",
                    "content": f"The previous output exceeded the max token limit. Rewrite it to at most {max_out_tokens} tokens while preserving all key content."
                })
                compressed_chunk = openai_chat(payload).strip()

            with open(stream_path, "a", encoding="utf-8", buffering=1) as f:
                f.write(compressed_chunk + "\n\n")
                f.flush()
                os.fsync(f.fileno())

        # Optional course end marker
        with open(stream_path, "a", encoding="utf-8", buffering=1) as f:
            f.write(f"--- COURSE END [{cname}] (courses/{cid}) ---\n\n")
            f.flush()
            os.fsync(f.fileno())

    if db is not None:
        _update_job(db, job_id, log_line=f"Streaming compression complete (course-aware): {stream_path}")

    return stream_path

# -----------------------------------------------------------------------------
# Indexing: store compressed doc + chunk into embedding rows
# -----------------------------------------------------------------------------
def chunk_for_embeddings(text: str, model: str, chunk_tokens: int) -> List[str]:
    if not text.strip():
        return []
    toks, enc = encode_text(text, model)
    chunks: List[str] = []
    for start in range(0, len(toks), chunk_tokens):
        sub = toks[start:start+chunk_tokens]
        chunks.append(decode_tokens(sub, enc))
    return chunks
def cosine_sim(a: List[float], b: List[float]) -> float:
    import math
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))
def persist_compressed_and_index(db, user_id: int, job_id: str, compressed_text: str) -> str:
    # Ensure output dir exists
    out_dir = os.path.abspath(os.environ.get("COMPRESSED_OUT_DIR", "compressed_out"))
    os.makedirs(out_dir, exist_ok=True)
    # Write artifact to disk
    filename = f"compressed_{user_id}_{job_id}.txt"
    out_path = os.path.join(out_dir, filename)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(compressed_text or "")
    # Store in Document for chat stuffing
    doc_id = uuid.uuid4().hex
    doc = Document(id=doc_id, user_id=user_id, job_id=job_id, content=sanitize_db_text(compressed_text))
    db.add(doc)
    db.commit()
    # Log artifact path for convenience
    _update_job(db, job_id, log_line=f"Final compressed artifact saved: {out_path}")
    return doc_id
# -----------------------------------------------------------------------------
# Job lifecycle: scrape → stream-compress → file
# -----------------------------------------------------------------------------
def _update_job(db, job_id: str, *, status: Optional[str] = None, duo: Optional[str] = None, log_line: Optional[str] = None):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        return
    if status:
        job.status = status
    if duo:
        job.duo_code = duo[:64]
    # Route log messages to file instead of DB to reduce memory and DB bloat
    if log_line:
        _append_job_log_file(job_id, log_line)
    job.updated_at = datetime.datetime.utcnow()
    db.add(job)
    db.commit()
def _status_callback_factory(job_id: str):
    def cb(kind: str, message: str):
        db = SessionLocal()
        try:
            if kind == "status":
                _update_job(db, job_id, status=message)
            elif kind == "duo":
                # Mirror the DUO code into status for immediate visibility
                _update_job(
                    db,
                    job_id,
                    status=f"DUO CODE: {message}",
                    duo=message,
                    log_line=f"Duo code captured: {message}"
                )
            else:
                _update_job(db, job_id, log_line=f"[{kind}] {message}")
        finally:
            db.close()
    return cb
# Global single-worker lock: ensures only one scrape runs at a time
JOB_LOCK = threading.Lock()
def _wait_for_job_slot(job_id: str, poll_seconds: float = 2.5):
    db = SessionLocal()
    try:
        # Try fast-path acquire
        if JOB_LOCK.acquire(blocking=False):
            _update_job(db, job_id, status="starting", log_line="Acquired worker slot")
            return
        # Otherwise, let the user know we are waiting
        _update_job(db, job_id, status="queued (waiting for another user's scrape to complete)", log_line="Waiting for previous job to finish")
        while True:
            got = JOB_LOCK.acquire(timeout=poll_seconds)
            if got:
                _update_job(db, job_id, status="starting", log_line="Acquired worker slot")
                return
            # Periodic status refresh
            _update_job(db, job_id, status="queued (waiting for another user's scrape to complete)", log_line="Still waiting for previous job to finish")
    finally:
        db.close()
def _release_job_slot():
    with contextlib.suppress(Exception):
        if JOB_LOCK.locked():
            JOB_LOCK.release()
def _now_utc():
    return datetime.datetime.utcnow()

def _get_or_create_auto(db, user_id: int) -> AutoScrape:
    rec = db.query(AutoScrape).filter(AutoScrape.user_id == user_id).first()
    if rec:
        return rec
    rec = AutoScrape(id=uuid.uuid4().hex[:32], user_id=user_id, enabled=False,
                     headless=True, created_at=_now_utc(), updated_at=_now_utc())
    db.add(rec); db.commit()
    return rec

def _schedule_next_24h(db, user_id: int):
    rec = _get_or_create_auto(db, user_id)
    rec.next_run_at = _now_utc() + datetime.timedelta(hours=24)
    rec.last_run_at = _now_utc()
    rec.updated_at = _now_utc()
    db.add(rec); db.commit()

def _has_active_job(db, user_id: int) -> bool:
    active = db.query(Job).filter(
        Job.user_id == user_id,
        Job.status.in_(["queued","starting","logging_in","compressing"])
    ).first()
    return bool(active)

def _enqueue_job_for_user(db, user_id: int, username: str, password: str, headless: bool, reuse_session_only: bool = False):
    job_id = uuid.uuid4().hex[:16]
    job = Job(id=job_id, user_id=user_id, status="queued", log="",
              created_at=_now_utc(), updated_at=_now_utc())
    db.add(job); db.commit()

    def worker():
        _wait_for_job_slot(job_id)
        try:
            run_scrape_and_index(user_id, username, password, headless, job_id, reuse_session_only=reuse_session_only)
        finally:
            _release_job_slot()
    t = threading.Thread(target=worker, name=f"auto-{job_id}", daemon=True)
    t.start()

def _resume_interrupted_jobs():
    db = SessionLocal()
    try:
        stuck = db.query(Job).filter(Job.status.in_([
            "queued", "starting", "logging_in", "compressing"
        ])).all()
        for j in stuck:
            # mark as queued again; scheduler/locks will manage ordering
            j.status = "queued"
            j.updated_at = _now_utc()
            db.add(j)
        db.commit()
    except Exception as e:
        log_exception("_resume_interrupted_jobs", e)
    finally:
        db.close()

def _scheduler_loop():
    # Only one scheduler in the formation: prefer web.1 or explicit RUN_SCHEDULER=1
    dyno = os.environ.get("DYNO", "")
    should_run = os.environ.get("RUN_SCHEDULER", "0") == "1" or dyno.endswith(".1")
    if not should_run:
        return
    # attempt rescue of interrupted jobs at boot
    _resume_interrupted_jobs()
    while True:
        db = SessionLocal()
        try:
            now = _now_utc()
            due = db.query(AutoScrape).filter(
                AutoScrape.enabled == True,
                AutoScrape.next_run_at != None,
                AutoScrape.next_run_at <= now
            ).all()
            for rec in due:
                if _has_active_job(db, rec.user_id):
                    # leave next_run_at as-is; loop will pick it up soon
                    continue
                # Reuse-only autoscrape: never auto-enter credentials
                sess_dir = _session_dir(rec.user_id)
                has_session = os.path.isdir(sess_dir) and any(os.scandir(sess_dir))
                if not has_session:
                    _update_job(db, job_id=str(rec.user_id), log_line="Autoscrape skipped: no warm session available")
                    # keep 24h cadence; still schedule next attempt
                    rec.next_run_at = now + datetime.timedelta(hours=24)
                    rec.updated_at = now
                    db.add(rec); db.commit()
                    continue
                
                # Enqueue a reuse-only job (blank creds)
                _enqueue_job_for_user(db, rec.user_id, "", "", bool(rec.headless), reuse_session_only=True)
                # schedule the *next* run immediately upon queueing
                rec.next_run_at = now + datetime.timedelta(hours=24)
                rec.updated_at = now
                db.add(rec); db.commit()

        except Exception as e:
            log_exception("_scheduler_loop", e)
        finally:
            db.close()
        time.sleep(60)

def _compute_current_term_label(now: Optional[datetime.datetime] = None) -> str:
    if not now:
        now = datetime.datetime.now()
    y = now.year
    m = now.month
    if 8 <= m <= 12:
        return f"Fall {y}"
    if 1 <= m <= 5:
        return f"Spring {y}"
    return f"Summer {y}"

def run_scrape_and_index(user_id: int, username: str, password: str, headless: bool, job_id: str, reuse_session_only: bool = False):
    db = SessionLocal()
    tmp_root = ""  # ensure defined for finally
    try:
        # Ensure current-term-only filters (as in your code above)...
        term_label_default = _compute_current_term_label()
        os.environ["CANVAS_FETCH_ALL_COURSES"] = "1"
        os.environ["CANVAS_FAVORITES_ONLY"] = "0"
        os.environ["CANVAS_INCLUDE_PAST_COURSES"] = "0"
        os.environ["CANVAS_INCLUDE_FUTURE_COURSES"] = "0"
        os.environ["CANVAS_INCLUDE_UNPUBLISHED"] = "1"
        os.environ["CANVAS_PER_PAGE"] = os.environ.get("CANVAS_PER_PAGE", "100")
        os.environ["CANVAS_ENROLLMENT_STATES"] = "active,invited,completed"
        os.environ["CANVAS_CURRENT_TERM_ONLY"] = "1"
        os.environ["CANVAS_TERM_LABEL"] = os.environ.get("CANVAS_TERM_LABEL", term_label_default)
        with contextlib.suppress(KeyError):
            del os.environ["CANVAS_COURSE_STATES"]
        _update_job(
            db, job_id, status="starting",
            log_line=(f"Configured Canvas filters: term={os.environ.get('CANVAS_TERM_LABEL')}, "
                      f"current_only={os.environ.get('CANVAS_CURRENT_TERM_ONLY')}, "
                      f"enrollment_states={os.environ.get('CANVAS_ENROLLMENT_STATES')}, "
                      f"course_states={'<removed>'}, "
                      f"unpublished={os.environ.get('CANVAS_INCLUDE_UNPUBLISHED')}, "
                      f"per_page={os.environ.get('CANVAS_PER_PAGE')}")
        )
        cb = _status_callback_factory(job_id)
        _update_job(db, job_id, status="logging_in",
                    log_line="Fetching all current-term courses (favorites off, per_page=100)")
        # Create a per-job live scrape stream file and expose to scraper
        scrape_path = _scrape_stream_file_path(user_id, job_id)
        with open(scrape_path, "w", encoding="utf-8") as f:
            f.write("")  # truncate/create
        os.environ["OCEAN_SCRAPE_STREAM_PATH"] = scrape_path
        _update_job(db, job_id, log_line=f"Live scrape stream file: {scrape_path}")
        # Point scraper to a persistent per-user session/profile
        sess_dir = _session_dir(user_id)
        os.environ["OCEAN_PERSIST_SESSION_DIR"] = sess_dir
        if reuse_session_only:
            # Never auto-login in autoscrape: require warm session only
            os.environ["OCEAN_REUSE_SESSION_ONLY"] = "1"
        else:
            with contextlib.suppress(KeyError):
                del os.environ["OCEAN_REUSE_SESSION_ONLY"]
        _update_job(db, job_id, log_line=f"Session dir: {sess_dir} (reuse_only={bool(reuse_session_only)})")


        call_user = "" if reuse_session_only else username
        call_pass = "" if reuse_session_only else password
        res = run_canvas_scrape_job(username=call_user, password=call_pass, headless=headless, status_callback=cb)

        input_path = (res or {}).get("input_path") or ""
        tmp_root = (res or {}).get("tmp_root") or ""
        _update_job(db, job_id, log_line=f"Scrape finished. input_path={input_path}")
        # Save/refresh warm session for next autoscrape
        try:
            _persist_session(tmp_root, sess_dir)
            _update_job(db, job_id, log_line="Session persisted for future reuse")
        except Exception as _e:
            log_exception("persist_session", _e)

        if not input_path or not os.path.exists(input_path):
            if reuse_session_only:
                _update_job(db, job_id, status="skipped", log_line="Autoscrape skipped: session expired / login required (no creds used)")
                return
            _update_job(db, job_id, status="failed", log_line="input.txt missing; aborting")
            return
        with open(input_path, "r", encoding="utf-8", errors="ignore") as f:
            raw = f.read()
        if not raw.strip():
            _update_job(db, job_id, status="failed", log_line="input.txt empty; aborting")
            return
        # Fallback: ensure live stream contains at least the full raw input
        scrape_path = os.environ.get("OCEAN_SCRAPE_STREAM_PATH", _scrape_stream_file_path(user_id, job_id))
        try:
            curr_size = os.path.getsize(scrape_path)
        except Exception:
            curr_size = 0
        if curr_size < len(raw.encode("utf-8")):
            with open(scrape_path, "a", encoding="utf-8", buffering=1) as f:
                f.write("\n" + raw)
                f.flush()
                os.fsync(f.fileno())

        _update_job(db, job_id, status="compressing",
                    log_line="Starting streaming compression: ~50,000-token blocks with dynamic global ratio")
        # Read the live scrape stream as the source for compression
        with open(scrape_path, "r", encoding="utf-8", errors="ignore") as f:
            raw_for_compress = f.read()
        if not raw_for_compress.strip():
            raw_for_compress = raw  # fail-safe
        # Stream-compress and finish
        stream_path = stream_compress_corpus_blocks(raw_for_compress, user_id, job_id, db=db, block_tokens=20000, target_ratio=0.5)
        _update_job(db, job_id, status="completed", log_line=f"Streaming compression complete: {stream_path}")
        # Read the rolling stream content and persist to Document to survive dyno restarts
        try:
            with open(stream_path, "r", encoding="utf-8", errors="ignore") as f:
                compressed_text_final = f.read()
        except Exception:
            compressed_text_final = raw_for_compress  # best-effort
        
        try:
            doc_id = persist_compressed_and_index(db, user_id, job_id, compressed_text_final)
            _update_job(db, job_id, log_line=f"Persisted compressed corpus to Document {doc_id} (DB-backed)")
        except Exception as e:
            log_exception("persist_compressed_and_index", e)
            _update_job(db, job_id, log_line="WARNING: Failed to persist compressed corpus to DB")
        
        # If auto-scrape is enabled, schedule the next run in 24h
        try:
            rec = _get_or_create_auto(db, user_id)
            if rec.enabled:
                _schedule_next_24h(db, user_id)
                _update_job(db, job_id, log_line="Auto-scrape scheduled for +24h")
        except Exception as e:
            log_exception("_schedule_next_24h", e)

    except Exception as e:
        log_exception("run_scrape_and_index", e)
        _update_job(db, job_id, status="failed", log_line=f"Exception: {e}")
    finally:
        with contextlib.suppress(Exception):
            if tmp_root and os.path.exists(tmp_root):
                shutil.rmtree(tmp_root, ignore_errors=True)
        db.close()

# -----------------------------------------------------------------------------
# Test Scrape: inject small fake corpus â†’ compress â†’ index (no Selenium)
# -----------------------------------------------------------------------------
TEST_SCRAPE_TEXT = """--- Scraped from Test Course at [https://canvas.cornell.edu/courses/TEST](https://canvas.cornell.edu/courses/TEST) ---
Course: CS 4780 Machine Learning.
Instructor: Prof. Ada Lovelace. Office hours Tue 2â€“4pm in Rhodes 475.
Grading policy: Homework 40%, Project 25%, Midterm 20%, Final 15%.
Late policy: 10% per day up to 3 days.
Assignment 1: Linear Regression due Sept 20 at 11:59pm on Canvas. Submit a single PDF with code appendix.
Modules: Week 1 (Intro, Linear Models), Week 2 (Gradient Descent, Regularization), Week 3 (Generalization).
Readings: ESLII Chapters 3â€“4.
Piazza is used for Q&A; announcements will be posted weekly.
Announcement: Project groups finalized by Sept 25. Datasets posted under Files â†’ Datasets.
"""
def run_test_and_index(user_id: int, job_id: str):
    db = SessionLocal()
    try:
        _update_job(db, job_id, status="starting", log_line="Test scrape started (injecting synthetic corpus)")
        raw = TEST_SCRAPE_TEXT
        # Create and populate the live scrape stream for the test run
        scrape_path = _scrape_stream_file_path(user_id, job_id)
        with open(scrape_path, "w", encoding="utf-8") as f:
            f.write("")
        with open(scrape_path, "a", encoding="utf-8", buffering=1) as f:
            f.write(raw + "\n")
            f.flush()
            os.fsync(f.fileno())
        _update_job(db, job_id, status="compressing",
        log_line="Starting streaming compression on synthetic corpus (~25,000-token blocks, ~50%)")
        # Read from the live stream for compression
        with open(scrape_path, "r", encoding="utf-8", errors="ignore") as f:
            raw_for_compress = f.read()
        stream_path = stream_compress_corpus_blocks(raw_for_compress, user_id, job_id, block_tokens=25000, target_ratio=0.5)
        _update_job(db, job_id, status="completed", log_line=f"Test streaming compression complete. stream_path={stream_path}")
        # Persist test compressed stream so chat works post-restart
        try:
            with open(stream_path, "r", encoding="utf-8", errors="ignore") as f:
                compressed_text_final = f.read()
            doc_id = persist_compressed_and_index(db, user_id, job_id, compressed_text_final)
            _update_job(db, job_id, log_line=f"Persisted test compressed corpus to Document {doc_id}")
        except Exception as e:
            log_exception("persist_test_compressed", e)

    except Exception as e:
        log_exception("run_test_and_index", e)
        _update_job(db, job_id, status="failed", log_line=f"Exception: {e}")
    finally:
        db.close()
# -----------------------------------------------------------------------------
# Retrieval + chat (RAG disabled here: send entire compressed corpus each time)
# -----------------------------------------------------------------------------
def latest_document_id(db, user_id: int) -> Optional[str]:
    row = db.query(Document).filter(Document.user_id == user_id).order_by(Document.created_at.desc()).first()
    return row.id if row else None
def latest_job_for_user(db, user_id: int) -> Optional[Job]:
    return db.query(Job).filter(Job.user_id == user_id).order_by(Job.created_at.desc()).first()
# Fix retrieve_context() vector shape and sorting
def retrieve_context(db, doc_id: str, question: str, top_k: int, token_budget: int) -> str:
    qvec_list = openai_embed([question])
    if not qvec_list:
        return ""
    qvec = qvec_list[0]
    rows = db.execute(sql_text("""
        SELECT id, text, embedding FROM chunks WHERE document_id = :doc
    """), {"doc": doc_id}).fetchall()
    scored: List[Tuple[float, str]] = []
    for _id, text_piece, emb_json in rows:
        try:
            vec = json.loads(emb_json)
            sim = cosine_sim(qvec, vec)
            scored.append((sim, text_piece))
        except Exception:
            continue
    scored.sort(key=lambda t: t[0], reverse=True)
    top = [t[1] for t in scored[:max(1, top_k)]]
    joined = "\n\n".join(top)
    packed = truncate_to_tokens(joined, token_budget, CHAT_MODEL)
    if not packed and joined:
        packed = joined[:MAX_CONTEXT_CHARS]
    return packed
# 3) Modify answer_with_context() to inject the timestamp
def answer_with_context(question: str, context_text: str, prev_user_messages: Optional[List[str]] = None) -> str:
    now_local = _ithaca_now_str()
    system = (
        "You are a helpful assistant that answers questions based on provided course materials. "
        "Be concise and cite from the provided context when relevant. "
        f"Current local time in Ithaca, NY: {now_local}"
    )
    messages = [{"role": "system", "content": system}]
    # Add last 2 prior user messages to provide conversational context
    if prev_user_messages:
        for m in prev_user_messages[-2:]:
            if isinstance(m, str) and m.strip():
                messages.append({"role": "user", "content": f"Earlier question for context: {m.strip()}"})
    user_prompt = f"Question: {question}\n\nRelevant course materials:\n{context_text}"
    messages.append({"role": "user", "content": user_prompt})
    payload = {
        "model": CHAT_MODEL,
        "messages": messages,
        "temperature": 0.2,
    }
    return openai_chat(payload)

# -----------------------------------------------------------------------------
# Minimal HTML helpers
# -----------------------------------------------------------------------------
# 2) Add a helper (place near other helpers)
def _ithaca_now_str() -> str:
    """
    Return current date/time in Ithaca, NY, e.g.
    'Saturday, September 13, 2025, 03:32 PM EDT (UTC-04:00)'
    """
    tz = ZoneInfo("America/New_York")
    now = datetime.datetime.now(tz)
    off = now.strftime("%z")  # e.g. -0400
    off_fmt = f"{off[:3]}:{off[3:]}" if len(off) == 5 else off
    return now.strftime(f"%A, %B %d, %Y, %I:%M %p %Z (UTC{off_fmt})")

def ocean_layout(title: str, body_html: str) -> str:
    return f"""
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
:root {{
  --ocean-bg1:#031a26;
  --ocean-bg2:#062a3f;
  --ocean-bg3:#0a3a52;
  --ocean-ink:#e8f4fb;
  --ocean-muted:#b6d2e3;
  --ocean-accent:#39c1ff;
  --ocean-accent-2:#3dd6c6;
  --ocean-border:rgba(81,164,204,0.25);
  --glass:rgba(8,24,36,0.55);
}}
* {{ box-sizing: border-box; }}
body {{
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  margin:0;
  color:var(--ocean-ink);
  background:
    radial-gradient(1200px 600px at 8% -10%, #0f5071 0%, rgba(15,80,113,0) 55%),
    radial-gradient(1000px 600px at 100% 0%, #0a3f5c 0%, rgba(10,63,92,0) 50%),
    linear-gradient(180deg, var(--ocean-bg1) 0%, var(--ocean-bg2) 45%, var(--ocean-bg3) 100%);
  background-attachment: fixed, fixed, fixed;
}}
 a {{ color:var(--ocean-accent); text-decoration:none; }}
 a:hover {{ text-decoration:underline; }}
 .container {{ max-width: 980px; margin: 0 auto; padding: 28px; }}
 .card {{
  background: var(--glass);
  border: 1px solid var(--ocean-border);
  border-radius: 14px;
  padding: 20px;
  margin: 16px 0;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}}
 .btn {{
  display: inline-block;
  color: #fff;
  padding: 11px 16px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.08);
  background: linear-gradient(135deg, #1aa3ff 0%, #0fb0b5 100%);
  box-shadow: 0 8px 16px rgba(16, 136, 178, 0.35), inset 0 1px 0 rgba(255,255,255,0.12);
  transition: transform .12s ease, box-shadow .12s ease, filter .12s ease, background .12s ease;
}}
 .btn:hover {{
  transform: translateY(-1px);
  box-shadow: 0 12px 22px rgba(16, 136, 178, 0.45), inset 0 1px 0 rgba(255,255,255,0.18);
  filter: brightness(1.04);
}}
 .btn:active {{
  transform: translateY(0);
  box-shadow: 0 6px 12px rgba(16,136,178,0.30);
}}
 input, textarea {{
  width: 100%;
  padding: 11px 12px;
  border-radius: 10px;
  border: 1px solid var(--ocean-border);
  background: rgba(2,18,28,0.6);
  color: var(--ocean-ink);
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}}
 input::placeholder, textarea::placeholder {{ color: var(--ocean-muted); }}
 input:focus, textarea:focus {{
  border-color: var(--ocean-accent);
  box-shadow: 0 0 0 3px rgba(57,193,255,0.15);
  background: rgba(3,22,34,0.75);
}}
 table {{ width:100%; border-collapse:collapse; }}
 th, td {{ text-align:left; padding:10px 8px; border-bottom:1px solid var(--ocean-border); vertical-align:top; }}
 tbody tr:nth-child(even) {{ background: rgba(255,255,255,0.02); }}
 .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }}
 .badge {{
  display:inline-block;
  padding:6px 10px;
  font-size:12px;
  color:#dff3ff;
  border-radius: 999px;
  border:1px solid rgba(255,255,255,0.12);
  background: linear-gradient(180deg, rgba(23,56,75,0.75) 0%, rgba(15,42,58,0.65) 100%);
}}
 .duo {{ font-size:18px; font-weight:700; color:#ffe066; }}
 .duo-banner {{
  font-size: 32px;
  font-weight: 900;
  color: #ffe066;
  padding: 14px 18px;
  border-radius: 14px;
  background: rgba(255, 224, 102, 0.08);
  border: 1px solid rgba(255, 224, 102, 0.35);
  text-align: center;
  letter-spacing: 1px;
}}
 h1, h2, h3 {{ margin: 6px 0 14px; }}
 </style>
 </head>
 <body>
 <div class="container">
 {body_html}
 </div>
 </body>
 </html>
 """.strip()
# -----------------------------------------------------------------------------
# Auth routes
# -----------------------------------------------------------------------------
@app.route("/signup", methods=["GET", "POST"])
def signup():
    db = SessionLocal()
    try:
        if request.method == "POST":
            username = (request.form.get("username") or "").strip().lower()
            password = (request.form.get("password") or "")
            if not username or not password:
                body = "<div class='card'>Missing username or password. <a href='/signup'>Back</a></div>"
                return ocean_layout("Sign up â€¢ Ocean Canvas Assistant", body), 400
            if db.query(User).filter(User.username == username).first():
                body = "<div class='card'>Username already taken. <a href='/signup'>Back</a></div>"
                return ocean_layout("Sign up â€¢ Ocean Canvas Assistant", body), 400
            user = User(username=username, password_hash=generate_password_hash(password))
            db.add(user)
            db.commit()
            session["user_id"] = user.id
            return redirect(url_for("dashboard"))
        body = f"""
<div class="card">
  <h2>Sign up</h2>
  <form method="post">
    <label>Username</label>
    <input name="username" placeholder="netid" />
    <label>Password</label>
    <input name="password" type="password" />
    <br><br>
    <button class="btn" type="submit">Create account</button>
  </form>
  <p>Already have an account? <a href="/login">Log in</a></p>
</div>
"""
        return ocean_layout("Sign up â€¢ Ocean Canvas Assistant", body)
    finally:
        db.close()
@app.route("/login", methods=["GET", "POST"])
def login():
    db = SessionLocal()
    try:
        if request.method == "POST":
            username = (request.form.get("username") or "").strip().lower()
            password = (request.form.get("password") or "")
            user = db.query(User).filter(User.username == username).first()
            if not user or not check_password_hash(user.password_hash, password):
                body = "<div class='card'>Invalid credentials. <a href='/login'>Back</a></div>"
                return ocean_layout("Log in â€¢ Ocean Canvas Assistant", body), 401
            session["user_id"] = user.id
            return redirect(url_for("dashboard"))
        body = f"""
<div class="card">
  <h2>Log in</h2>
  <form method="post">
    <label>Username</label>
    <input name="username" placeholder="netid" />
    <label>Password</label>
    <input name="password" type="password" />
    <br><br>
    <button class="btn" type="submit">Log in</button>
  </form>
  <p>No account? <a href="/signup">Sign up</a></p>
</div>
"""
        return ocean_layout("Log in â€¢ Ocean Canvas Assistant", body)
    finally:
        db.close()
@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))
# -----------------------------------------------------------------------------
# Dashboard and job control (adds Test Scrape button) + Live Duo banner
# -----------------------------------------------------------------------------
@app.route("/")
@login_required
def dashboard():
    db = SessionLocal()
    try:
        u = current_user(db)
        jobs = db.query(Job).filter(Job.user_id == u.id).order_by(Job.created_at.desc()).limit(12).all()
        last_job = latest_job_for_user(db, u.id)
        stream_ready = False
        if last_job:
            stream_ready = os.path.exists(_stream_file_path(u.id, last_job.id))
        rows = []
        for j in jobs:
            duo = (j.duo_code or "").strip()
            duo_html = f"<div class='duo'>DUO CODE: {duo}</div>" if duo else ""
            rows.append(f"""
<tr>
  <td><span class="mono">{j.id}</span></td>
  <td>{j.status or ''}{' ' + duo_html if duo_html else ''}</td>
  <td><span class="mono">{(j.updated_at or j.created_at).strftime('%Y-%m-%d %H:%M:%S')}</span></td>
  <td><a class="btn" href="/job/{j.id}">Open</a></td>
</tr>
""")
        jobs_html = f"""
<div class="card">
  <h2>Jobs</h2>
  <table>
    <thead><tr><th>ID</th><th>Status</th><th>Updated</th><th></th></tr></thead>
    <tbody>
      {''.join(rows) if rows else '<tr><td colspan="4">No jobs yet.</td></tr>'}
    </tbody>
  </table>
</div>
""".strip()

        # derive current auto state (for the toggle card)
        auto = _get_or_create_auto(db, u.id)
        next_run = auto.next_run_at.strftime('%Y-%m-%d %H:%M:%S UTC') if auto.next_run_at else '—'
        auto_card = f"""
<div class="card">
  <h3>Auto-scrape (every 24h)</h3>
  <form method="post" action="/auto_toggle">
    <label><input type="checkbox" name="enabled" {'checked' if auto.enabled else ''}/> Enable daily auto-scrape</label>
    <div style="margin-top:8px;">
      <span class="badge">Next run: {next_run}</span>
    </div>
    <br>
    <button class="btn" type="submit">Save</button>
  </form>
  <p style="margin-top:10px;color:#b6d2e3;">
    Note: The first manual scrape stores your Canvas credentials (encrypted) for automatic runs.
  </p>
</div>
""".strip()

        body = f"""
<div id="duo-container" class="card" style="display:none;">
  <div id="duo-banner" class="duo-banner">DUO CODE: ------</div>
</div>
<div class="card">
  <h1>Chanvas (Working on new features...)</h1>
  <p>{'✅ Compressed stream is ready for chat.' if stream_ready else '⌛ No compressed stream yet. Start a scrape or test scrape.'}</p>
  <p><a class="btn" href="/chat">Open Chat UI</a></p>
</div>
{auto_card}
<div class="card">
  <h3>Start Canvas scrape</h3>
  <form method="post" action="/start_job">
    <label>Cornell NetID</label>
    <input name="username" placeholder="netid" />
    <label>Password</label>
    <input name="password" type="password" />
    <label><input type="checkbox" name="headless" checked /> Headless</label>
    <br><br>
    <button class="btn" type="submit">Start Job</button>
  </form>
  <p><em>Once login begins, a Duo code may appear here as DUO CODE: ######.</em></p>
</div>
<div class="card">
  <h3>Test Scrape</h3>
  <form method="post" action="/start_test">
    <button class="btn" type="submit">Run Test</button>
  </form>
</div>
{jobs_html}
<script>
(function() {{
  const container = document.getElementById('duo-container');
  const banner = document.getElementById('duo-banner');
  async function poll() {{
    try {{
      const r = await fetch('/latest_duo', {{ headers: {{ 'Cache-Control': 'no-cache' }} }});
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.duo_code && data.duo_code.trim() !== '') {{
        container.style.display = 'block';
        banner.textContent = 'DUO CODE: ' + data.duo_code.trim();
      }} else {{
        container.style.display = 'none';
      }}
    }} catch (e) {{}}
  }}
  poll();
  setInterval(poll, 1500);
}})();
</script>
""".strip()

        return ocean_layout("Dashboard • Ocean Canvas Assistant", body)
    finally:
        db.close()

def _append_job_log(db, job: Job, kind: str, message: str):
    now = datetime.datetime.utcnow().isoformat()
    line = f"[{now}] {kind}: {message}\n"
    job.log = (job.log or "") + line
    job.updated_at = datetime.datetime.utcnow()
    db.add(job)
    db.commit()
@app.route("/auto_toggle", methods=["POST"])
@login_required
def auto_toggle():
    db = SessionLocal()
    try:
        u = current_user(db)
        enabled = True if request.form.get("enabled") else False
        rec = _get_or_create_auto(db, u.id)
        rec.enabled = enabled
        # If enabling and we already have a last manual scrape credentials in memory from session,
        # do nothing here; credentials get written when /start_job runs next.
        # If disabling, clear next_run_at to avoid accidental firing.
        if not enabled:
            rec.next_run_at = None
        rec.updated_at = _now_utc()
        db.add(rec); db.commit()
        return redirect(url_for("dashboard"))
    finally:
        db.close()

@app.route("/start_job", methods=["POST"])
@login_required
def start_job():
    db = SessionLocal()
    try:
        u = current_user(db)
        username = (request.form.get("username") or "").strip()
        password = (request.form.get("password") or "")
        headless = True if request.form.get("headless") else False
        if not username or not password:
            return ocean_layout("Start Job", "<div class='card'>NetID and password required.</div>"), 400
        job_id = uuid.uuid4().hex[:16]
        job = Job(
            id=job_id,
            user_id=u.id,
            status="queued",
            log="",
            created_at=datetime.datetime.utcnow(),
            updated_at=datetime.datetime.utcnow(),
        )
        db.add(job)
        db.commit()
        # If user has toggled auto-scrape on, store the latest creds for reuse
        auto = _get_or_create_auto(db, u.id)
        if auto.enabled:
            # Reuse-session-only autoscrape: do NOT save passwords
            auto.username = username or auto.username
            auto.password_enc = ""  # purge any previously stored cred
            auto.headless = bool(headless)
            auto.updated_at = _now_utc()
            if not auto.next_run_at:
                auto.next_run_at = _now_utc() + datetime.timedelta(hours=24)
            db.add(auto); db.commit()


        def worker():
            # Queue: wait for slot, then run; always release
            _wait_for_job_slot(job_id)
            try:
                run_scrape_and_index(u.id, username, password, headless, job_id)
            finally:
                _release_job_slot()
        t = threading.Thread(target=worker, name=f"scrape-{job_id}", daemon=True)
        t.start()
        return redirect(url_for("dashboard"))
    finally:
        db.close()
@app.route("/start_test", methods=["POST"])
@login_required
def start_test():
    db = SessionLocal()
    try:
        u = current_user(db)
        job_id = uuid.uuid4().hex[:16]
        job = Job(
            id=job_id,
            user_id=u.id,
            status="queued",
            log="",
            created_at=datetime.datetime.utcnow(),
            updated_at=datetime.datetime.utcnow(),
        )
        db.add(job)
        db.commit()
        def worker():
            # Queue: wait for slot, then run; always release
            _wait_for_job_slot(job_id)
            try:
                run_test_and_index(u.id, job_id)
            finally:
                _release_job_slot()
        t = threading.Thread(target=worker, name=f"test-{job_id}", daemon=True)
        t.start()
        return redirect(url_for("dashboard"))
    finally:
        db.close()
@app.route("/job/<job_id>", methods=["GET"])
@login_required
def job_detail(job_id):
    db = SessionLocal()
    try:
        u = current_user(db)
        job = db.query(Job).filter(Job.id == job_id, Job.user_id == u.id).first()
        if not job:
            return ocean_layout("Job", "<div class='card'>Job not found.</div>"), 404
        duo_html = f"<div class='duo'>DUO CODE: {job.duo_code}</div>" if (job.duo_code or "").strip() else "<div class='badge'>No Duo code captured yet.</div>"
        # In job_detail(job_id), replace the body HTML with IDs and add the poller:
        body = f"""
        <div class="card">
          <h2>Job <span class="mono">{job.id}</span></h2>
          <p>Status: <span id="job-status" class="badge">{job.status or ''}</span></p>
          {duo_html}
          <p><a class="btn" href="/">Back to dashboard</a></p>
        </div>
        <div class="card">
          <h3>Logs</h3>
          <pre id="job-log" class="mono" style="white-space:pre-wrap;">{sanitize_db_text(job.log or '').strip() or '(no logs yet)'}</pre>
        </div>
        <script>
        (function() {{
          async function poll() {{
            try {{
              const r = await fetch('/job_state/{job.id}', {{ headers: {{ 'Cache-Control': 'no-cache' }} }});
              if (!r.ok) return;
              const data = await r.json();
              const logEl = document.getElementById('job-log');
              const statusEl = document.getElementById('job-status');
              if (statusEl && typeof data.status === 'string') {{
                statusEl.textContent = data.status;
              }}
              if (logEl && typeof data.log === 'string') {{
                logEl.textContent = data.log.trim() || '(no logs yet)';
              }}
            }} catch (e) {{}}
          }}
          poll();
          setInterval(poll, 1500);
        }})();
        </script>
        """
        return ocean_layout("Job â€¢ Ocean Canvas Assistant", body)
    finally:
        db.close()
# -----------------------------------------------------------------------------
# Chat (always attach the entire compressed Document.content to each query)
#   Updated: keep input box open; include last 2 user messages in request
# -----------------------------------------------------------------------------
@app.route("/chat", methods=["GET", "POST"])
@login_required
def chat():
    db = SessionLocal()
    try:
        u = current_user(db)
        if request.method == "POST":
            question = (request.form.get("question") or "").strip()
            if not question:
                return ocean_layout("Chat â€¢ Ocean Canvas Assistant", "<div class='card'>Enter a question.</div>")
            # Load latest rolling compressed corpus from stream file instead of Document
            last_job = latest_job_for_user(db, u.id)
            if not last_job:
                return ocean_layout("Chat • Ocean Canvas Assistant", "<div class='card'>No recent job found. Start a scrape or test scrape.</div>")
            
            stream_path = _stream_file_path(u.id, last_job.id)
            full_context = ""
            if os.path.exists(stream_path):
                with open(stream_path, "r", encoding="utf-8", errors="ignore") as f:
                    full_context = f.read().strip()
            
            if not full_context:
                # Fallback: use the latest DB-backed Document for restart resilience
                doc_id = latest_document_id(db, u.id)
                if doc_id:
                    row = db.query(Document).filter(Document.id == doc_id).first()
                    full_context = (row.content or "").strip()
            
            if not full_context:
                return ocean_layout("Chat • Ocean Canvas Assistant", "<div class='card'>No compressed context found yet. Start a scrape or test scrape.</div>")

            answer = answer_with_context(question, full_context, prev_user_messages=prev_user_msgs)
            # Update session chat history (store only user prompts to keep cookie small)
            hist.append(question)
            if len(hist) > 20:
                hist = hist[-20:]
            session["chat_history"] = hist
            # Keep typing box open on the answer page
            body = f"""
<div class="card">
  <h2>Answer</h2>
  <div class="mono" style="white-space:pre-wrap;">{sanitize_db_text(answer)}</div>
</div>
<div class="card">
  <h3>Ask another</h3>
  <form method="post">
    <label>Question</label>
    <textarea name="question" rows="4" placeholder="Ask about course materials..."></textarea>
    <br><br>
    <button class="btn" type="submit">Ask</button>
  </form>
</div>
<div class="card">
  <a class="btn" href="/">Back to dashboard</a>
</div>
"""
            return ocean_layout("Chat â€¢ Ocean Canvas Assistant", body)
                # GET
        last_job = latest_job_for_user(db, u.id)
        stream_ready = False
        if last_job:
            stream_path = _stream_file_path(u.id, last_job.id)
            stream_ready = os.path.exists(stream_path)
        body = f"""
<div class="card">
  <h2>Chat</h2>
  <p>{'✅ Compressed stream is ready for chat.' if stream_ready else '⌛ No compressed stream yet. Start a scrape or test scrape.'}</p>
  <form method="post">
    <label>Question</label>
    <textarea name="question" rows="4" placeholder="Ask about course materials..."></textarea>
    <br><br>
    <button class="btn" type="submit">Ask</button>
  </form>
</div>
<div class="card">
  <a class="btn" href="/">Back to dashboard</a>
</div>
"""
        return ocean_layout("Chat â€¢ Ocean Canvas Assistant", body)
    finally:
        db.close()
# -----------------------------------------------------------------------------
# Live Duo endpoint for newest job (JSON for polling)
# -----------------------------------------------------------------------------
@app.route("/latest_duo", methods=["GET"])
@login_required
def latest_duo():
    db = SessionLocal()
    try:
        u = current_user(db)
        job = db.query(Job).filter(Job.user_id == u.id).order_by(Job.created_at.desc()).first()
        if not job:
            return jsonify({"job_id": "", "duo_code": "", "status": ""}), 200
        duo = (job.duo_code or "").strip()
        return jsonify({"job_id": job.id, "duo_code": duo, "status": job.status or ""}), 200
    finally:
        db.close()
# Replace job_state() with file-backed log reading
@app.route("/job_state/<job_id>", methods=["GET"])
@login_required
def job_state(job_id):
    db = SessionLocal()
    try:
        u = current_user(db)
        job = db.query(Job).filter(Job.id == job_id, Job.user_id == u.id).first()
        if not job:
            return jsonify({"status": "", "duo_code": "", "log": ""}), 404
        try:
            with open(_job_log_path(job_id), "r", encoding="utf-8", errors="ignore") as f:
                log_text = f.read()
        except Exception:
            log_text = sanitize_db_text(job.log or "")
        return jsonify({
            "status": job.status or "",
            "duo_code": (job.duo_code or "").strip(),
            "log": log_text
        }), 200
    finally:
        db.close()
# -----------------------------------------------------------------------------
# Entrypoint / health
# -----------------------------------------------------------------------------
@app.route("/healthz")
def healthz():
    return "ok", 200
@app.route("/download_stream/<job_id>")
@login_required
def download_stream(job_id):
    db = SessionLocal()
    try:
        u = current_user(db)
        job = db.query(Job).filter(Job.id == job_id, Job.user_id == u.id).first()
        if not job:
            return ocean_layout("Download", "<div class='card'>Job not found.</div>"), 404
        path = _stream_file_path(u.id, job.id)
        if not os.path.exists(path):
            return ocean_layout("Download", "<div class='card'>Stream file not found.</div>"), 404
        return send_file(path, as_attachment=True, download_name=os.path.basename(path))
    finally:
        db.close()
if __name__ == "__main__":
    # kick off the background scheduler (guarded to a single dyno)
    threading.Thread(target=_scheduler_loop, name="scheduler", daemon=True).start()
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)





