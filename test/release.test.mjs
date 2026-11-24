import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addGitRelease, npmPublishChannel } from '../scripts/sync-release.mjs'

const repo = 'https://github.com/YunongDai2005/dsh-thetwo'
const commit = 'a'.repeat(40)
const publishedAt = '2026-11-24T06:21:31Z'
const old = { version: '0.1.0', publishTimestamp: 1, source: { type: 'npm' } }
const newer = { version: '0.1.10', publishTimestamp: 3, source: { type: 'git', url: repo + '.git', commit: 'b'.repeat(40) } }
const catalog = () => ({ plugins: [{ name: 'dsh-thetwo', repository: { url: repo }, versions: structuredClone([newer, old]) }] })

test('a GitHub release is inserted by version and can be replayed without changing the catalog', () => {
  const index = catalog()
  assert.equal(addGitRelease(index, '0.1.2', commit, publishedAt), true)
  assert.deepEqual(index.plugins[0].versions, [newer, {
    version: '0.1.2', publishTimestamp: 1795501291, source: { type: 'git', url: repo + '.git', commit },
  }, old])
  assert.equal(addGitRelease(index, '0.1.2', commit, publishedAt), false)
  assert.equal(addGitRelease(index, '0.1.0', commit, publishedAt), false)
  assert.throws(() => addGitRelease(index, '0.1.2', 'c'.repeat(40), publishedAt), /commit/)
})

test('only stable releases with a fixed commit and a publication date enter Discover', () => {
  for (const args of [['0.2.0-rc.1', commit, publishedAt], ['0.2.0', 'main', publishedAt], ['0.2.0', commit, '']]) {
    const index = catalog()
    assert.throws(() => addGitRelease(index, ...args))
    assert.deepEqual(index, catalog())
  }
})

test('npm replays require the same archive and backfills keep a newer latest tag', () => {
  const packument = { 'dist-tags': { latest: '0.1.10' }, versions: { '0.1.10': { dist: { integrity: 'sha512-original' } } } }
  assert.equal(npmPublishChannel(packument, '0.2.0', 'sha512-new'), 'latest')
  assert.equal(npmPublishChannel(packument, '0.1.2', 'sha512-patch'), 'maintenance')
  assert.equal(npmPublishChannel(packument, '0.1.10', 'sha512-original'), 'published')
  assert.throws(() => npmPublishChannel(packument, '0.1.10', 'sha512-different'), /integrity/)
})
