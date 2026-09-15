/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')

const MACHO_MAGIC_32 = 0xfeedface
const MACHO_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const PE_SIGNATURE = 0x00004550
const PE_MACHINE_X64 = 0x8664
const PE_MACHINE_ARM64 = 0xaa64

const CPU_TYPE_IA32 = 0x00000007
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

/** Only the headers are needed; native binaries can be tens of megabytes. */
const HEADER_BYTES = 64 * 1024

function readHeader(filePath) {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const bytesRead = fs.readSync(descriptor, buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    fs.closeSync(descriptor)
  }
}

function normalizeMachoCpuType(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return 'x64'
  if (cpuType === CPU_TYPE_ARM64) return 'arm64'
  if (cpuType === CPU_TYPE_IA32) return 'ia32'
  return ''
}

/**
 * Returns every architecture contained in a Mach-O or PE binary, as
 * electron-builder arch names ("x64", "arm64"). Universal binaries report both.
 * Returns an empty array for anything that is not a native executable (scripts,
 * wasm), so callers can treat "unknown" separately from "wrong architecture".
 */
function readBinaryArchitectures(filePath) {
  let buffer
  try {
    buffer = readHeader(filePath)
  } catch {
    return []
  }
  if (buffer.length < 8) return []

  const fatMagic = buffer.readUInt32BE(0)
  if (fatMagic === FAT_MAGIC || fatMagic === FAT_MAGIC_64) {
    const entrySize = fatMagic === FAT_MAGIC_64 ? 32 : 20
    const count = Math.min(buffer.readUInt32BE(4), 32)
    const architectures = []
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 8 + index * entrySize
      if (entryOffset + 4 > buffer.length) break
      const name = normalizeMachoCpuType(buffer.readUInt32BE(entryOffset))
      if (name && !architectures.includes(name)) architectures.push(name)
    }
    return architectures
  }

  const thinMagic = buffer.readUInt32LE(0)
  if (thinMagic === MACHO_MAGIC_32 || thinMagic === MACHO_MAGIC_64) {
    const name = normalizeMachoCpuType(buffer.readUInt32LE(4))
    return name ? [name] : []
  }

  if (buffer.readUInt16LE(0) === 0x5a4d) {
    const peOffset = buffer.readUInt32LE(0x3c)
    if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== PE_SIGNATURE) return []
    const machine = buffer.readUInt16LE(peOffset + 4)
    if (machine === PE_MACHINE_X64) return ['x64']
    if (machine === PE_MACHINE_ARM64) return ['arm64']
  }

  return []
}

module.exports = { readBinaryArchitectures }
