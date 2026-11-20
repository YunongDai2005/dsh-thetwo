const credentialKey = value => typeof value === 'string' && /^llm-[a-z0-9-]+\/[a-z0-9][a-z0-9-]{0,100}$/.test(value)
const packageName = value => typeof value === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value) && value.length <= 214
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value) && value.length < 100
function pluginRow(row) {
  if (!row || !packageName(row.name) || !version(row.version) || row.name === 'dsh-thetwo' || row.name.startsWith('@deepseek-ai/')) throw new Error('插件列表无效')
  return { name: row.name, version: row.version, enabled: row.enabled === true, spec: `${row.name}@${row.version}` }
}
export class EnvironmentSync {
  constructor(ctx) { this.credentials = ctx?.get?.('credentials'); this.plugins = ctx?.get?.('pluginManager') }
  async exportKeys() {
    if (!this.credentials) throw new Error('此 DSH 未提供凭据服务')
    try {
      const records = await this.credentials.listRecords(), result = []
      for (const entry of records) {
        if (entry.kind !== 'api-key' || !credentialKey(entry.key)) continue
        const record = await this.credentials.readRecord(entry.key)
        if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key.length && record.key.length <= 8192) result.push({ id: entry.key, key: record.key })
        if (result.length > 256) throw new Error('limit')
      }
      return result
    } catch { throw new Error('无法读取可同步的 API 密钥，请检查本机凭据服务') }
  }
  async importKeys(records, allowed) {
    if (!this.credentials) throw new Error('此 DSH 未提供凭据服务')
    if (!Array.isArray(records) || records.length > 256 || records.some(row => !credentialKey(row?.id) || typeof row.key !== 'string' || !row.key || row.key.length > 8192)) throw new Error('收到的 API 密钥记录无效')
    const result = { added: 0, kept: 0 }
    try {
      for (const row of records) {
        if (!allowed()) break
        await this.credentials.modifyRecord(row.id, async current => {
          if (!allowed()) return current
          if (current) { result.kept++; return current }
          result.added++; return { kind: 'api-key', key: row.key }
        })
      }
      return result
    } catch { throw new Error('API 密钥保存失败，请检查本机凭据服务；已有密钥保持不变') }
  }
  async exportPlugins() {
    if (!this.plugins) throw new Error('此 DSH 未提供插件管理服务')
    const rows = await this.plugins.listBundles(), result = []
    for (const row of rows) {
      if (row.official || !row.installed || row.availability !== 'profile' || row.name === 'dsh-thetwo' || row.name.startsWith('@deepseek-ai/')) continue
      // Local paths, URLs, git sources and aliases are machine-specific. Only
      // registry package identities and pinned versions cross the device boundary.
      if (row.source && row.source !== row.name && !row.source.startsWith(`${row.name}@`)) continue
      if (row.source && /[:\\/#]/.test(row.source.replace(row.name, ''))) continue
      try { result.push(pluginRow(row)) } catch { /* Unsupported package metadata stays local. */ }
    }
    return result.slice(0, 256)
  }
  async planPlugins(rows) {
    if (!this.plugins) throw new Error('此 DSH 未提供插件管理服务')
    if (!Array.isArray(rows) || rows.length > 256) throw new Error('插件列表无效')
    const remote = rows.map(pluginRow), local = await this.plugins.listBundles()
    return remote.map(row => {
      const existing = local.find(item => item.name === row.name && (item.installed || item.availability === 'installation'))
      return { ...row, status: !existing ? 'missing' : existing.version === row.version ? 'installed' : 'version-differs', localVersion: existing?.version }
    })
  }
  async install(rows, allowed) {
    const results = []
    for (const row of rows) {
      if (!allowed()) throw new Error('插件同步已关闭或设备已解除配对')
      const current = await this.planPlugins([row])
      if (!allowed()) throw new Error('插件同步已关闭或设备已解除配对')
      if (current[0].status !== 'missing') { results.push({ spec: row.spec, application: 'kept' }); continue }
      const result = await this.plugins.installBundle(row.spec, { enabled: row.enabled, saveExact: true })
      results.push({ spec: row.spec, application: result.application })
      // Build approval remains in DSH's package manager; never approve scripts,
      // overwrite existing packages, or import foreign plugin configuration.
    }
    return results
  }
}
