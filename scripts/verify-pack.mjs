import { readFile, readdir, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { join, basename } from 'node:path'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const file = process.argv[2] ?? `artifacts/dsh-thetwo-${manifest.version}.tgz`
const packed = await readFile(file), tar = gunzipSync(packed), entries = new Map()
const hash = data => createHash('sha256').update(data).digest('hex')
const field = (block, offset, size) => block.subarray(offset, offset + size).toString().replace(/\0.*$/s, '')
for (let cursor = 0; cursor + 512 <= tar.length;) {
  const block = tar.subarray(cursor, cursor + 512)
  if (block.every(byte => byte === 0)) break
  const name = field(block, 0, 100), prefix = field(block, 345, 155), size = parseInt(field(block, 124, 12), 8)
  assert.ok(Number.isSafeInteger(size) && size >= 0)
  const path = prefix ? `${prefix}/${name}` : name
  const type = field(block, 156, 1)
  if (type === '0' || type === '') {
    assert.ok(path.startsWith('package/') && !entries.has(path))
    entries.set(path.slice(8), tar.subarray(cursor + 512, cursor + 512 + size))
  } else assert.ok(['5', 'x', 'g'].includes(type), `unsupported tar entry ${path}`)
  cursor += 512 + Math.ceil(size / 512) * 512
}
const expected = ['README.md', 'cordis.patch.yml', 'package.json', ...(await readdir('lib')).filter(name => name.endsWith('.js')).map(name => `lib/${name}`)].sort()
assert.deepEqual([...entries.keys()].sort(), expected, 'pack contains only publishable source files')
for (const path of expected) assert.equal(hash(entries.get(path)), hash(await readFile(path)), `${path} differs from source`)
assert.ok((await readFile('lib/client.js', 'utf8')).includes(`version = '${manifest.version}'`))
const result = { version: manifest.version, file: basename(file), sha256: hash(packed), files: expected.length, sourceMatch: true }
await writeFile(join('artifacts', `verification-${manifest.version}.json`), JSON.stringify(result, null, 2) + '\n')
await writeFile(join('artifacts', `SHA256SUMS-${manifest.version}.txt`), `${result.sha256}  ${result.file}\n`)
console.log(JSON.stringify(result))
