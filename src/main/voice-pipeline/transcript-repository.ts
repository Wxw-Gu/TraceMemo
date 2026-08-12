import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import type { TranscriptMessageStatus, TranscriptRecord, TranscriptRepository } from './types'

type TranscriptKey = Omit<
  TranscriptRecord,
  'transcript' | 'language' | 'durationMs' | 'createdAt' | 'updatedAt'
>

type CompatibleTranscriptKey = Pick<
  TranscriptRecord,
  | 'accountId'
  | 'messageIdentity'
  | 'processorVersion'
  | 'recognizerId'
  | 'modelVersion'
  | 'modelFingerprint'
>

function transcriptRecord(row: Record<string, unknown>): TranscriptRecord {
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
      CREATE TABLE IF NOT EXISTS voice_transcript_message_states (
        account_id TEXT NOT NULL,
        message_identity TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'transcribed', 'failed')),
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, message_identity)
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
    return transcriptRecord(row)
  }

  findLatest(accountId: string, messageIdentity: string): TranscriptRecord | null {
    const row = this.database
      .prepare(
        `SELECT account_id, message_identity, audio_hash, processor_version,
                recognizer_id, model_version, model_fingerprint, transcript,
                language, duration_ms, created_at, updated_at
         FROM voice_transcripts
         WHERE account_id = ? AND message_identity = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(accountId, messageIdentity) as Record<string, unknown> | undefined
    if (!row) return null
    return transcriptRecord(row)
  }

  findCompatible(key: CompatibleTranscriptKey): TranscriptRecord | null {
    const row = this.database
      .prepare(
        `SELECT account_id, message_identity, audio_hash, processor_version,
                recognizer_id, model_version, model_fingerprint, transcript,
                language, duration_ms, created_at, updated_at
         FROM voice_transcripts
         WHERE account_id = ? AND message_identity = ? AND processor_version = ?
           AND recognizer_id = ? AND model_version = ? AND model_fingerprint = ?
           AND trim(transcript) <> ''
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(
        key.accountId,
        key.messageIdentity,
        key.processorVersion,
        key.recognizerId,
        key.modelVersion,
        key.modelFingerprint
      ) as Record<string, unknown> | undefined
    return row ? transcriptRecord(row) : null
  }

  mergeFrom(databasePath: string): number {
    this.database.prepare('ATTACH DATABASE ? AS legacy_voice').run(databasePath)
    try {
      const hasTranscripts = this.database
        .prepare(
          `SELECT 1 FROM legacy_voice.sqlite_master
           WHERE type = 'table' AND name = 'voice_transcripts'`
        )
        .get()
      if (!hasTranscripts)
        throw new Error('Legacy voice transcript database has no transcript table')

      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec(`
          INSERT OR IGNORE INTO main.voice_transcripts (
            account_id, message_identity, audio_hash, processor_version,
            recognizer_id, model_version, model_fingerprint, transcript,
            language, duration_ms, created_at, updated_at
          )
          SELECT account_id, message_identity, audio_hash, processor_version,
                 recognizer_id, model_version, model_fingerprint, transcript,
                 language, duration_ms, created_at, updated_at
          FROM legacy_voice.voice_transcripts
          WHERE trim(transcript) <> ''
        `)
        const inserted = Number(
          (
            this.database.prepare('SELECT changes() AS count').get() as
              | Record<string, unknown>
              | undefined
          )?.count || 0
        )
        this.database.exec(`
          INSERT INTO main.voice_transcript_message_states (
            account_id, message_identity, state, error, updated_at
          )
          SELECT account_id, message_identity, 'transcribed', NULL, MAX(updated_at)
          FROM legacy_voice.voice_transcripts
          WHERE trim(transcript) <> ''
          GROUP BY account_id, message_identity
          ON CONFLICT (account_id, message_identity) DO UPDATE SET
            state = 'transcribed', error = NULL, updated_at = excluded.updated_at
          WHERE excluded.updated_at > voice_transcript_message_states.updated_at
        `)
        this.database.exec('COMMIT')
        return inserted
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    } finally {
      this.database.exec('DETACH DATABASE legacy_voice')
    }
  }

  getMessageStatus(accountId: string, messageIdentity: string): TranscriptMessageStatus {
    const row = this.database
      .prepare(
        `SELECT state, error, updated_at
         FROM voice_transcript_message_states
         WHERE account_id = ? AND message_identity = ?`
      )
      .get(accountId, messageIdentity) as Record<string, unknown> | undefined
    return {
      accountId,
      messageIdentity,
      state: row ? (String(row.state) as TranscriptMessageStatus['state']) : 'pending',
      updatedAt: row ? Number(row.updated_at) : 0,
      error: row?.error ? String(row.error) : undefined
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
    this.database
      .prepare(
        `INSERT INTO voice_transcript_message_states (
           account_id, message_identity, state, error, updated_at
         ) VALUES (?, ?, 'transcribed', NULL, ?)
         ON CONFLICT (account_id, message_identity) DO UPDATE SET
           state = excluded.state,
           error = NULL,
           updated_at = excluded.updated_at`
      )
      .run(record.accountId, record.messageIdentity, record.updatedAt)
  }

  markFailure(accountId: string, messageIdentity: string, error: string): void {
    this.database
      .prepare(
        `INSERT INTO voice_transcript_message_states (
           account_id, message_identity, state, error, updated_at
         ) VALUES (?, ?, 'failed', ?, ?)
         ON CONFLICT (account_id, message_identity) DO UPDATE SET
           state = excluded.state,
           error = excluded.error,
           updated_at = excluded.updated_at`
      )
      .run(accountId, messageIdentity, error.slice(0, 500), Date.now())
  }

  close(): void {
    this.database.close()
  }
}
