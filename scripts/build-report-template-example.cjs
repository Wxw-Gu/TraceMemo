#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { ZipArchive } = require('archiver')

const root = path.resolve(__dirname, '..')
const source = path.join(root, 'examples', 'report-template-basic')
const outputPath = path.join(root, 'examples', 'report-template-basic.zip')
const output = fs.createWriteStream(outputPath)
const archive = new ZipArchive({ zlib: { level: 9 } })
output.on('close', () => console.log(`wrote ${outputPath} (${archive.pointer()} bytes)`))
archive.on('error', (error) => { throw error })
archive.pipe(output)
archive.file(path.join(source, 'manifest.json'), { name: 'manifest.json' })
archive.file(path.join(source, 'template.html'), { name: 'template.html' })
// 使用 1x1 PNG 作为虚构预览占位图，避免引入真实用户媒体。
archive.append(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), { name: 'preview.png' })
archive.finalize()
