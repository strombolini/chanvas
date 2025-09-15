import datetime
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, String, DateTime, Text, Integer, ForeignKey

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Job(Base):
    __tablename__ = "jobs"
    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    status = Column(String(64), index=True)
    duo_code = Column(String(64))
    log = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

class Document(Base):
    __tablename__ = "documents"
    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    job_id = Column(String(64), ForeignKey("jobs.id"), index=True)
    content = Column(Text)  # Full aggregated input.txt
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Chunk(Base):
    __tablename__ = "chunks"
    id = Column(String(64), primary_key=True)
    document_id = Column(String(64), ForeignKey("documents.id"), index=True, nullable=False)
    chunk_index = Column(Integer)
    text = Column(Text)
    embedding = Column(Text)  # JSON-serialized list[float] for portability
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
