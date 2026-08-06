import crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'

export interface LocalAccountIdentity {
  wxid: string
  nickname?: string
  avatar?: string
}

interface VarUint {
  value: number
  end: number
}

interface EncodedRecord {
  key: string
  value: Buffer
  end: number
}

const PROFILE_FILE = path.join('all_users', 'config', 'global_config')
const FILE_PREFIX_BYTES = 4
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024
const CIPHER_KEY = Buffer.from('xwechat_crypt_key', 'utf8').subarray(0, 16)
const CIPHER_IV = Buffer.alloc(16)
const PROFILE_FIELDS = {
  wxid: 'mmkv_key_user_name',
  nickname: 'mmkv_key_nick_name',
  avatar: 'mmkv_key_head_img_url'
} as const

function decodeVarUint(buffer: Buffer, offset: number, limit = buffer.length): VarUint | null {
  let value = 0
  let shift = 0

  for (let cursor = offset; cursor < limit && shift <= 28; cursor += 1, shift += 7) {
    const byte = buffer[cursor]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, end: cursor + 1 }
  }
  return null
}

function decodeRecord(buffer: Buffer, offset: number): EncodedRecord | null {
  const keySize = decodeVarUint(buffer, offset)
  if (!keySize || keySize.value < 1 || keySize.value > 128) return null

  const keyEnd = keySize.end + keySize.value
  if (keyEnd > buffer.length) return null
  const key = buffer.toString('utf8', keySize.end, keyEnd)
  if (!key.startsWith('mmkv_key_') || !/^[\x20-\x7e]+$/.test(key)) return null

  const valueSize = decodeVarUint(buffer, keyEnd)
  if (!valueSize || valueSize.value < 1 || valueSize.value > MAX_RECORD_BYTES) return null
  const valueEnd = valueSize.end + valueSize.value
  if (valueEnd > buffer.length) return null

  return { key, value: buffer.subarray(valueSize.end, valueEnd), end: valueEnd }
}

function decodeTextValue(value: Buffer): string {
  const textSize = decodeVarUint(value, 0)
  if (!textSize || textSize.end + textSize.value !== value.length) return ''
  const text = value.toString('utf8', textSize.end).replace(/\0+$/g, '').trim()
  if (!text || text.includes('\ufffd')) return ''
  const hasControlCharacter = Array.from(text).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 && code !== 9 && code !== 10 && code !== 13
  })
  return hasControlCharacter ? '' : text
}

function collectProfileFields(buffer: Buffer): Map<string, string> {
  const fields = new Map<string, string>()
  const wanted = new Set<string>(Object.values(PROFILE_FIELDS))

  for (let offset = 0; offset < buffer.length && fields.size < wanted.size; ) {
    const record = decodeRecord(buffer, offset)
    if (!record) {
      offset += 1
      continue
    }
    if (wanted.has(record.key)) {
      const text = decodeTextValue(record.value)
      if (text) fields.set(record.key, text)
    }
    offset = record.end
  }

  return fields
}

function normalizeAvatar(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function readLocalAccountIdentity(dataRoot: string): LocalAccountIdentity | null {
  const file = path.join(path.resolve(dataRoot), PROFILE_FILE)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size <= FILE_PREFIX_BYTES || stat.size > MAX_FILE_BYTES) return null

    const source = fs.readFileSync(file)
    const decipher = crypto.createDecipheriv('aes-128-cfb', CIPHER_KEY, CIPHER_IV)
    decipher.setAutoPadding(false)
    const decoded = Buffer.concat([
      decipher.update(source.subarray(FILE_PREFIX_BYTES)),
      decipher.final()
    ])
    const fields = collectProfileFields(decoded)
    const wxid = fields.get(PROFILE_FIELDS.wxid) || ''
    if (!/^[a-zA-Z0-9_-]{3,128}$/.test(wxid)) return null

    return {
      wxid,
      nickname: fields.get(PROFILE_FIELDS.nickname) || undefined,
      avatar: normalizeAvatar(fields.get(PROFILE_FIELDS.avatar))
    }
  } catch {
    return null
  }
}

export function accountDirectoryBelongsToIdentity(directoryName: string, wxid: string): boolean {
  const directory = directoryName.trim().toLowerCase()
  const identity = wxid.trim().toLowerCase()
  if (!identity) return false
  if (directory === identity) return true
  if (!directory.startsWith(`${identity}_`)) return false
  return /^[a-z0-9]{4}$/.test(directory.slice(identity.length + 1))
}

export function deriveAccountWxid(directoryName: string): string | undefined {
  const directory = directoryName.trim()
  if (!directory) return undefined
  const wxidPrefix = directory.match(/^(wxid_[^_]+)/i)
  if (wxidPrefix) return wxidPrefix[1]
  const suffixed = directory.match(/^(.+)_([a-z0-9]{4})$/i)
  return suffixed?.[1] || undefined
}
