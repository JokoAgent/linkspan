import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import test from 'node:test'
import { cloudflaredArtifact, prepareCloudflared, QUICK_TUNNEL_LIMITS, startQuickTunnel, validateCloudflareLocalOrigin, verifyCloudflared } from '../dist/index.js'

test('metadata is target-specific and unsupported platforms fail without downloads', () => {
  const expected = [
    ['win32-x64', 40115200, '9d23f8b8bee69f4db958a59e44480a9d49242e1e50264ecb1de49428639ee360'],
    ['linux-x64', 40104141, '7e0373c8786337d2babc809cf0e5ce8ab365c12782dfab89299271a34f83c694'],
    ['linux-arm64', 37499101, '6b5693dcbf0d712cff5657eb97fe68e484bbcfe4bfa2efff336ac49777472f55'],
    ['darwin-x64', 41248368, '14e9b5dd552cbe488207010232298b78e3bcbd846740cc5ac002c1df5f2a2efb'],
    ['darwin-arm64', 39053522, '873c1903c21639879653cdc5a9c2dd8dfd06f0571daf518ae45950512d819930']
  ]
  for (const [target, bytes, digest] of expected) {
    const artifact = cloudflaredArtifact(target)
    assert.equal(artifact.target, target)
    assert.equal(artifact.version, '2026.10.3-linkspan.1')
    assert.equal(artifact.binaryBytes, bytes)
    assert.equal(artifact.binarySha256, digest)
    assert.equal(artifact.sourceSha256, '6c6901ae333508e1c529184bf90cb87ff59592620d293401db38415269908311')
    assert.ok(Object.isFrozen(artifact))
  }
  for (const target of ['win32-arm64', 'linux-ia32', 'android-arm64', '__proto__']) {
    assert.throws(() => cloudflaredArtifact(target), { code: 'unsupported_platform' })
  }
  assert.equal(QUICK_TUNNEL_LIMITS.maximumInflightRequests, 200)
  assert.equal(QUICK_TUNNEL_LIMITS.serverSentEvents, false)
})

test('only an explicit loopback carrier origin can be forwarded', () => {
  assert.equal(validateCloudflareLocalOrigin('https://127.0.0.1:4400'), 'https://127.0.0.1:4400')
  assert.equal(validateCloudflareLocalOrigin('https://[::1]:4400/'), 'https://[::1]:4400')
  for (const origin of ['http://127.0.0.1:4400', 'https://localhost:4400', 'https://0.0.0.0:4400', 'https://192.168.0.1:4400', 'https://169.254.169.254:4400', 'https://127.0.0.1', 'https://u:p@127.0.0.1:4400', 'https://127.0.0.1:4400/api', 'https://127.0.0.1:4400?x=1', 'https://127.0.0.1:4400#x', 'https://127.1:4400', 'https://2130706433:4400']) {
    assert.throws(() => validateCloudflareLocalOrigin(origin), { code: 'invalid_input' })
  }
})

test('verification rejects unrelated executables and does not overwrite host files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkspan-helper-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'untrusted.exe')
  const originCaPool = join(directory, 'certificates.pem')
  await writeFile(originCaPool, rootCertificates[0])
  await writeFile(executable, 'host-owned-content')
  await assert.rejects(verifyCloudflared({ executable, target: 'win32-x64' }), { code: 'integrity' })
  await assert.rejects(startQuickTunnel({ requestId: 'test', executable, localOrigin: 'https://127.0.0.1:4400', originCaPool, originServerName: 'origin.example' }), { code: 'integrity' })
  assert.equal(await readFile(executable, 'utf8'), 'host-owned-content')
  await assert.rejects(verifyCloudflared({ executable: 'relative.exe', target: 'win32-x64' }), { code: 'invalid_input' })
  await assert.rejects(prepareCloudflared({ directory: 'relative', target: 'win32-x64' }), { code: 'invalid_input' })
})

test('cancellation, deadlines and invalid stable identities fail before a process can start', async () => {
  const base = { requestId: 'test', executable: join(tmpdir(), 'must-not-start'), localOrigin: 'https://127.0.0.1:4400', originCaPool: join(tmpdir(), 'must-not-read'), originServerName: 'origin.example' }
  await assert.rejects(startQuickTunnel({ ...base, signal: AbortSignal.abort() }), { code: 'cancelled' })
  await assert.rejects(startQuickTunnel({ ...base, deadline: Date.now() - 1000 }), { code: 'deadline' })
  for (const requestId of ['', 'x\nsecret', 'x'.repeat(129)]) await assert.rejects(startQuickTunnel({ ...base, requestId }), { code: 'invalid_input' })
  await assert.rejects(startQuickTunnel({ ...base, startupTimeoutMs: 0 }), { code: 'invalid_input' })
  await assert.rejects(startQuickTunnel({ ...base, deadline: Number.NaN }), { code: 'invalid_input' })
})

test('origin verification cannot be disabled or replaced with private material', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkspan-origin-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const originCaPool = join(directory, 'certificates.pem')
  const base = { requestId: 'test', executable: join(tmpdir(), 'must-not-start'), localOrigin: 'https://127.0.0.1:4400', originCaPool, originServerName: 'origin.example' }
  for (const content of ['', 'private material', rootCertificates[0] + '\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----', 'x'.repeat(65537), '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----']) {
    await writeFile(originCaPool, content)
    await assert.rejects(startQuickTunnel(base), { code: 'invalid_input' })
  }
  await assert.rejects(startQuickTunnel({ ...base, originCaPool: 'relative.pem' }), { code: 'invalid_input' })
  for (const originServerName of ['', undefined, 'origin.example/target', 'origin.example\nno-tls-verify', '-origin.example']) {
    await assert.rejects(startQuickTunnel({ ...base, originServerName }), { code: 'invalid_input' })
  }
})
