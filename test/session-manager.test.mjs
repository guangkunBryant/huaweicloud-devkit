import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WS_EXEC_INDEX_URL,
  splitBase64Chunks,
  UPLOAD_CHUNK_SIZE,
  parseDiagChainOutput,
  getCurrentWorkspaceId,
  setWorkspaceId,
  formatPortConflictWarning,
  formatPortDriftWarning,
  formatProxyPortWarning,
  buildExposeRemediation,
  TUNNEL_URL_PATTERN,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';

test('ws-exec dynamic import uses file:// URL (Windows-safe)', async () => {
  assert.ok(WS_EXEC_INDEX_URL.startsWith('file://'), `expected file:// URL, got: ${WS_EXEC_INDEX_URL}`);
  const mod = await import(WS_EXEC_INDEX_URL);
  assert.equal(typeof mod.connectHwlinkTerminalSession, 'function');
  assert.equal(typeof mod.executeHwlinkCommand, 'function');
});

test('splitBase64Chunks splits into chunks no larger than the limit and reassembles losslessly', () => {
  const base64 = Buffer.from('x'.repeat(100000)).toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= UPLOAD_CHUNK_SIZE, `chunk exceeds limit: ${chunk.length}`);
  }
  assert.equal(chunks.join(''), base64);
});

test('splitBase64Chunks returns a single chunk for small inputs', () => {
  const base64 = Buffer.from('hello').toString('base64');
  const chunks = splitBase64Chunks(base64);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], base64);
});

test('currentWorkspaceId defaults to null without env or setter', () => {
  assert.equal(getCurrentWorkspaceId(), null);
});

test('setWorkspaceId caches and updates env var', () => {
  const testId = 'test-workspace-123';
  setWorkspaceId(testId);
  assert.equal(getCurrentWorkspaceId(), testId);
  assert.equal(process.env.HW_WORKSPACE_ID, testId);
  setWorkspaceId(null);
});

test('parseDiagChainOutput extracts status, code and latency per hop (with ANSI noise)', () => {
  const stdout =
    '\x1b[0m=== DIAG CHAIN ===\r\n' +
    'diag:tunnel:PASS status=200 latency=0.125\r\n' +
    'diag:proxy:FAIL status=502 latency=0.003\r\n' +
    'diag:pm2:PASS\r\n' +
    '\x1b[1;32mVERDICT:COMPLETE\x1b[0m';
  const result = parseDiagChainOutput(stdout, ['tunnel', 'proxy', 'pm2']);
  assert.equal(result.complete, false);
  assert.equal(result.firstFailure, 'proxy');
  assert.deepEqual(result.failedHops, ['proxy']);
  assert.deepEqual(result.missingHops, []);
  assert.equal(result.hops.length, 3);
  assert.equal(result.hops[0].statusCode, 200);
  assert.equal(result.hops[0].latencyMs, 125);
  assert.equal(result.hops[1].statusCode, 502);
  assert.equal(result.hops[1].latencyMs, 3);
  assert.equal(result.hops[2].status, 'PASS');
});

test('parseDiagChainOutput flags a hop whose result line is missing entirely', () => {
  const stdout = 'diag:tunnel:PASS status=200 latency=0.010\ndiag:proxy:FAIL status=000 latency=0.000';
  const result = parseDiagChainOutput(stdout, ['tunnel', 'proxy', 'pm2']);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingHops, ['pm2']);
  assert.deepEqual(result.failedHops, ['proxy']);
  assert.equal(result.firstFailure, 'proxy');
});

test('parseDiagChainOutput returns parseWarning when no hop lines are found', () => {
  const result = parseDiagChainOutput('some unrelated output', ['tunnel']);
  assert.equal(result.complete, false);
  assert.equal(result.hops.length, 0);
  assert.match(result.parseWarning, /No hop results/);
  assert.ok(result.rawOutput);
});

test('formatPortConflictWarning returns undefined when port is unchanged', () => {
  assert.equal(formatPortConflictWarning(80, 80), undefined);
});

test('formatPortConflictWarning reports the real auto-assigned port', () => {
  assert.equal(formatPortConflictWarning(80, 81), 'Port 80 is in use — auto-assigned port 81');
});

test('formatPortDriftWarning is undefined without drift', () => {
  assert.equal(formatPortDriftWarning(80, 80), undefined);
});

test('formatPortDriftWarning names both ports and the re-bind command', () => {
  const msg = formatPortDriftWarning(80, 81);
  assert.match(msg, /nginx now listens on port 81/);
  assert.match(msg, /devbridge port create <tunnelId> -p 81 --protocol http -a/);
});

test('buildExposeRemediation includes credential sourcing and host command with port', () => {
  const msg = buildExposeRemediation(82);
  assert.match(msg, /source \/tmp\/hw_creds\.sh/);
  assert.match(msg, /source \/tmp\/hw_api_key/);
  assert.match(msg, /devbridge port create <tunnelId> -p 82 --protocol http -a/);
  assert.match(msg, /use THAT port instead/);
});

test('TUNNEL_URL_PATTERN matches a real tunnel URL', () => {
  const m = 'TUNNEL_URL:https://c4rdv7bv-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN);
  assert.ok(m, 'valid URL should match');
  assert.equal(m[1], 'https://c4rdv7bv-80.devbridge-s2.hwtunnel.com');
});

test('TUNNEL_URL_PATTERN rejects URL with empty tunnel prefix', () => {
  assert.equal('TUNNEL_URL:https://-80.devbridge-s2.hwtunnel.com'.match(TUNNEL_URL_PATTERN), null);
});

test('TUNNEL_URL_PATTERN no longer matches the migrated legacy domain', () => {
  assert.equal('TUNNEL_URL:https://c4rdv7bv-80.cn-north-4-bridge.myhuaweicloud.com'.match(TUNNEL_URL_PATTERN), null);
});

test('formatProxyPortWarning is undefined without drift', () => {
  assert.equal(formatProxyPortWarning(80, 80), undefined);
});

test('formatProxyPortWarning explains proxy templates ignore auto-increment', () => {
  const msg = formatProxyPortWarning(80, 81);
  assert.match(msg, /still listens on port 80/);
  assert.match(msg, /auto-increment does not apply to proxy configs/);
});
