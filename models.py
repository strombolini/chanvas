import datetime
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, String, DateTime, Text, Integer, ForeignKey

Base = declarative_base()

"""Stores user account information including login credentials. Each user can have
  multiple scraping jobs and documents."""
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), unique=True, index=True, nullable=False)
    netid = Column(String(255), unique=True, index=True, nullable=True)  # Cornell NetID
    password_hash = Column(String(255), nullable=True)  # Nullable for OAuth users
    email = Column(String(255), unique=True, index=True, nullable=True)  # For OAuth
    oauth_provider = Column(String(64))  # 'google' for Cornell Gmail
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

"""Represents a single Canvas scraping task with status tracking and logs. Each job
  belongs to one user but can generate multiple documents."""
class Job(Base):
    __tablename__ = "jobs"
    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    status = Column(String(64), index=True)
    duo_code = Column(String(64))
    log = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

"""Contains the full compressed/processed Canvas content from a scraping job.
  Multiple documents can belong to the same job (though current code creates one per job)."""
class Document(Base):
    __tablename__ = "documents"
    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    job_id = Column(String(64), ForeignKey("jobs.id"), index=True)
    content = Column(Text)  # Full aggregated input.txt
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

"""Small pieces of a document split for RAG/embedding search. Each chunk belongs to
  exactly one document and contains a text segment with its AI embedding vector."""
class Chunk(Base):
    __tablename__ = "chunks"
    id = Column(String(64), primary_key=True)
    document_id = Column(String(64), ForeignKey("documents.id"), index=True, nullable=False)
    chunk_index = Column(Integer)
    text = Column(Text)
    embedding = Column(Text)  # JSON-serialized list[float] for portability
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

"""Stores individual course documents from browser extension scraping.
  Each course is stored as a separate document with its Canvas course ID."""
class CourseDoc(Base):
    __tablename__ = "course_docs"
    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    course_id = Column(String(64), index=True, nullable=False)  # Canvas course ID
    course_name = Column(String(255))  # Human-readable course name
    content = Column(Text)  # Raw scraped content for this course
    embedding = Column(Text)  # JSON-serialized embedding vector for the entire course
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)
