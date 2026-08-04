import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import type { TranscriptRecord, TranscriptRepository } from './types'

type TranscriptKey = Omit<
  TranscriptRecord,
  'transcript' | 'language' | 'durationMs' | 'createdAt' | 'updatedAt'
>

export class SqliteTranscriptRepository implements TranscriptRepository {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS voice_transcripts (
        account_id TEXT NOT NULL,
        message_identity TEXT NOT NULL,
        audio_hash TEXT NOT NULL,
        processor_version TEXT NOT NULL,
        recognizer_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL,
        transcript TEXT NOT NULL,
        language TEXT,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (
          account_id, message_identity, audio_hash, processor_version,
          recognizer_id, model_version, model_fingerprint
        )
      ) STRICT;
    `)
  }

  find(key: TranscriptKey): TranscriptRecord | null {
    const row = this.database
      .prepare(
        `SELECT account_id, message_identity, audio_hash, processor_version,
                recognizer_id, model_version, model_fingerprint, transcript,
                language, duration_ms, created_at, updated_at
         FROM voice_transcripts
         WHERE account_id = ? AND message_identity = ? AND audio_hash = ?
           AND processor_version = ? AND recognizer_id = ? AND model_version = ?
           AND model_fingerprint = ?`
      )
      .get(
        key.accountId,
        key.messageIdentity,
        key.audioHash,
        key.processorVersion,
        key.recognizerId,
        key.modelVersion,
        key.modelFingerprint
      ) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      accountId: String(row.account_id),
      messageIdentity: String(row.message_identity),
      audioHash: String(row.audio_hash),
      processorVersion: String(row.processor_version),
      recognizerId: String(row.recognizer_id),
      modelVersion: String(row.model_version),
      modelFingerprint: String(row.model_fingerprint),
      transcript: String(row.transcript),
      language: row.language ? String(row.language) : undefined,
      durationMs: Number(row.duration_ms),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  save(record: TranscriptRecord): void {
    this.database
      .prepare(
        `INSERT INTO voice_transcripts (
           account_id, message_identity, audio_hash, processor_version,
           recognizer_id, model_version, model_fingerprint, transcript,
           language, duration_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (
           account_id, message_identity, audio_hash, processor_version,
           recognizer_id, model_version, model_fingerprint
         ) DO UPDATE SET
           transcript = excluded.transcript,
           language = excluded.language,
           duration_ms = excluded.duration_ms,
           updated_at = excluded.updated_at`
      )
      .run(
        record.accountId,
        record.messageIdentity,
        record.audioHash,
        record.processorVersion,
        record.recognizerId,
        record.modelVersion,
        record.modelFingerprint,
        record.transcript,
        record.language ?? null,
        record.durationMs,
        record.createdAt,
        record.updatedAt
      )
  }

  close(): void {
    this.database.close()
  }
}
