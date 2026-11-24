import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const name = 'dsh-thetwo'
const registry = 'https://registry.npmjs.org/' + name
const numeric = new Intl.Collator('en', { numeric: true })

export function addGitRelease(index, version, commit, publishedAt) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'expected a stable release version')
  assert.match(commit, /^[a-f0-9]{40}$/, 'expected a full commit SHA')
  const publishTimestamp = Math.floor(Date.parse(publishedAt) / 1000)
  assert.ok(Number.isSafeInteger(publishTimestamp) && publishTimestamp > 0, 'expected a release publication date')
  const plugin = index.plugins.find(entry => entry.name === name)
  assert.ok(plugin, 'TheTwo is missing from the catalog')
  const existing = plugin.versions.find(entry => entry.version === version)
  if (existing) {
    if (existing.source.type === 'git') assert.equal(existing.source.commit, commit, 'release already points to a different commit')
    return false
  }
  plugin.versions.push({ version, publishTimestamp, source: { type: 'git', url: plugin.repository.url + '.git', commit } })
  plugin.versions.sort((left, right) => numeric.compare(right.version, left.version))
  return true
}

export function npmPublishChannel(packument, version, integrity) {
  const existing = packument.versions[version]
  if (existing) {
    assert.equal(existing.dist.integrity, integrity, 'npm archive integrity differs from the release')
    return 'published'
  }
  const latest = packument['dist-tags'].latest
  return latest && numeric.compare(version, latest) < 0 ? 'maintenance' : 'latest'
}

async function registryMetadata() {
  const res = await fetch(registry + '?check=' + Date.now(), { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('npm registry returned HTTP ' + res.status)
  return res.json()
}

async function main([action, version, commit, publishedAt]) {
  if (action === 'index') {
    const file = 'market-index.json'
    const index = JSON.parse(await readFile(file, 'utf8'))
    if (addGitRelease(index, version, commit, publishedAt)) await writeFile(file, JSON.stringify(index, null, 2) + '\n')
    return
  }
  assert.ok(action === 'npm-channel' || action === 'verify-npm', 'unknown release operation')
  const archive = await readFile('artifacts/' + name + '-' + version + '.tgz')
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
  const packument = await registryMetadata()
  const channel = npmPublishChannel(packument, version, integrity)
  if (action === 'npm-channel') {
    console.log(channel)
    return
  }
  assert.equal(channel, 'published', 'waiting for npm to publish the version')
  assert.ok(numeric.compare(packument['dist-tags'].latest, version) >= 0, 'waiting for the npm latest tag')
  const url = new URL(packument.versions[version].dist.tarball)
  url.searchParams.set('check', String(Date.now()))
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('npm tarball returned HTTP ' + res.status)
  assert.ok(archive.equals(Buffer.from(await res.arrayBuffer())), 'downloaded npm tarball differs from the release')
  console.log(name + '@' + version + ' verified against the downloaded npm tarball')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
