import { createHash } from 'node:crypto'

export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
const MAX_ATTACHMENTS = 128
const keyOf = ref => `${ref.mediaType ? 'image' : 'file'}:${ref.attachmentId}:${ref.name ?? ''}`
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

export function attachmentRefs(events) {
  const refs = new Map()
  const walk = (value, depth = 0) => {
    if (depth > 100) throw new Error('附件引用层级过深')
    if (!value || typeof value !== 'object') return
    if ('attachmentId' in value) {
      if (!/^sha256:[a-f0-9]{64}$/.test(value.attachmentId) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_ATTACHMENT_BYTES) throw new Error('附件引用无效或超过 24 MiB')
      if (value.name !== undefined && (typeof value.name !== 'string' || !value.name || value.name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(value.name) || ['.', '..'].includes(value.name))) throw new Error('附件名称无效')
      if (value.mediaType) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType) || !Number.isSafeInteger(value.width) || value.width < 1 || !Number.isSafeInteger(value.height) || value.height < 1) throw new Error('图片附件引用无效')
      } else if (!value.name) throw new Error('文件附件缺少名称')
      refs.set(keyOf(value), value)
      if (refs.size > MAX_ATTACHMENTS) throw new Error('单个会话附件超过 128 个')
      return
    }
    for (const child of Object.values(value)) walk(child, depth + 1)
  }
  walk(events)
  const list = [...refs.values()]
  if (list.reduce((total, ref) => total + ref.bytes, 0) > MAX_ATTACHMENT_BYTES) throw new Error('单个会话附件合计超过 24 MiB，暂不传输')
  return list
}
function requireStore(store, refs) {
  if (refs.length && !store) throw new Error('此 DSH 未提供附件存储服务')
}
export async function exportAttachments(store, events, metadataOnly = false) {
  const refs = attachmentRefs(events)
  requireStore(store, refs)
  if (metadataOnly) return undefined
  const result = []
  for (const ref of refs) {
    let bytes
    if (ref.mediaType) bytes = Buffer.from((await store.readImage(ref)).data)
    else {
      const chunks = []; let size = 0
      for await (const chunk of store.readFileStream(ref)) {
        size += chunk.byteLength
        if (size > ref.bytes) throw new Error('附件长度与会话引用不符')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
    }
    if (bytes.length !== ref.bytes || sha(bytes) !== ref.attachmentId) throw new Error('附件校验失败')
    result.push({ key: keyOf(ref), data: bytes.toString('base64') })
  }
  return result
}
export async function importAttachments(store, snapshot) {
  const refs = attachmentRefs(snapshot.events)
  requireStore(store, refs)
  const blobs = snapshot.attachments ?? []
  if (!Array.isArray(blobs) || blobs.length !== refs.length) throw new Error('附件缺失或数量不符')
  const byKey = new Map(blobs.map(blob => [blob?.key, blob?.data]))
  const verified = refs.map(ref => {
    const encoded = byKey.get(keyOf(ref))
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(ref.bytes / 3) * 4) throw new Error('附件缺失或长度不符')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded || bytes.length !== ref.bytes || sha(bytes) !== ref.attachmentId) throw new Error('附件校验失败')
    return { ref, bytes }
  })
  // Verify the complete set before publishing anything; commit all blobs before
  // admitting the session that refers to them. Partial storage failures can only
  // leave unreachable immutable blobs, never a broken conversation.
  for (const { ref, bytes } of verified) {
    const input = { data: bytes, name: ref.name, mediaType: ref.mediaType }
    const saved = ref.mediaType ? await store.saveImage(input) : await store.saveFile(input)
    if (saved.attachmentId !== ref.attachmentId || saved.bytes !== ref.bytes || saved.name !== ref.name || (ref.mediaType && (saved.width !== ref.width || saved.height !== ref.height || saved.mediaType !== ref.mediaType))) throw new Error('附件在本机保存后发生变化，未导入会话')
  }
}
