import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}
export async function atomicJson(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync() }
  finally { await handle.close() }
  try { await rename(temporary, file) }
  catch (e) { await unlink(temporary).catch(() => {}); throw e }
}
