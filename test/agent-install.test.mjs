import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function makeEnv(home, extra = {}) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
  };
  // Clear agent home overrides so installs land in the temp home, not the real one.
  for (const key of ['ATOMCODE_HOME', 'DSH_HOME', 'HUAWEICLOUD_HOME', 'OFFICE_CLAW_CONFIG_ROOT']) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function run(target, home, cwd, cmd, extraEnv = {}) {
  return spawnSync(process.execPath, [setupCli, cmd, '--target', target], {
    cwd,
    env: makeEnv(home, extraEnv),
    encoding: 'utf8',
    timeout: 60000,
  });
}

function fakeCodexEnv(cwd, options = {}) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(cwd, 'codex.log');
  const scriptPath = join(cwd, 'fake-codex.mjs');
  writeFileSync(
    scriptPath,
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log('codex 0.0.0');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  console.log(process.env.FAKE_CODEX_LIST_OUTPUT || '');
  process.exit(0);
}
if (process.env.FAKE_CODEX_FAIL_PLUGIN_ADD === '1' && args[0] === 'plugin' && args[1] === 'add') {
  console.error('fake plugin add failed');
  process.exit(1);
}
process.exit(0);
`,
    'utf8',
  );
  const commandPath = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(commandPath, `#!/usr/bin/env sh\n"${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    chmodSync(commandPath, 0o755);
  }
  return {
    PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
    FAKE_CODEX_LOG: logPath,
    ...(options.failPluginAdd ? { FAKE_CODEX_FAIL_PLUGIN_ADD: '1' } : {}),
    ...(options.listOutput ? { FAKE_CODEX_LIST_OUTPUT: options.listOutput } : {}),
    logPath,
  };
}

function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
}

function pluginVersion(pluginsDir) {
  const p = join(pluginsDir, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

test('opencode install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('opencode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenCode\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.config', 'opencode', 'skills')) >= 6);
    const pd = join(home, '.config', 'opencode', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pd, '.installed')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const res = run('opencode', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    const res = run('opencode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.config', 'opencode', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('opencode install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    assert.equal(run('opencode', home, cwd, 'install').status, 0);
    assert.ok(countSkills(join(home, '.config', 'opencode', 'skills')) >= 6);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('workbuddy', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[WorkBuddy\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.workbuddy', 'skills')) >= 6);
    const pd = join(home, '.workbuddy', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const res = run('workbuddy', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    const res = run('workbuddy', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.workbuddy', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.workbuddy', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workbuddy install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    assert.equal(run('workbuddy', home, cwd, 'install').status, 0);
    assert.ok(countSkills(join(home, '.workbuddy', 'skills')) >= 6);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('codex-desktop', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Codex Desktop\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, 'plugins', 'huaweicloud-devkit', 'skills')) >= 6);
    const pd = join(home, 'plugins', 'huaweicloud-devkit');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex-desktop uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
    const res = run('codex-desktop', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, 'plugins', 'huaweicloud-devkit', 'skills')), 0);
    assert.ok(!existsSync(join(home, 'plugins', 'huaweicloud-devkit')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli help lists supported agent targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = spawnSync(process.execPath, [setupCli, 'help'], {
      cwd,
      env: makeEnv(home),
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.match(res.stdout, /install --target workbuddy/);
    assert.match(res.stdout, /install --target dsh/);
    assert.match(res.stdout, /install --target codearts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('openclaw install creates skills, MCP server, and safety policy in .agents', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('openclaw', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[OpenClaw\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.agents', 'skills')) >= 6);
    const pd = join(home, '.agents', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.ok(existsSync(join(pd, '.installed')));
    assert.equal(pluginVersion(pd), pkg.version);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('openclaw uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('openclaw', home, cwd, 'install').status, 0);
    const res = run('openclaw', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.agents', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.agents', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('hermes', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[Hermes Agent\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.hermes', 'skills')) >= 6);
    const pd = join(home, '.hermes', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
    const allowlistPath = join(home, '.hermes', 'shell-hooks-allowlist.json');
    assert.ok(existsSync(allowlistPath), 'shell hook allowlist must be written on install');
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    const entry = (allowlist.approvals || []).find(
      (a) =>
        a &&
        a.event === 'pre_tool_call' &&
        typeof a.command === 'string' &&
        a.command.includes('huaweicloud-safety.py'),
    );
    assert.ok(entry, 'allowlist must pre-authorize the pre_tool_call safety hook');
    const pluginDir = join(home, '.hermes', 'plugins', 'huaweicloud-safety');
    assert.ok(existsSync(join(pluginDir, 'plugin.yaml')), 'hook plugin manifest must be installed');
    assert.ok(existsSync(join(pluginDir, '__init__.py')), 'hook plugin module must be installed');
    const init = readFileSync(join(pluginDir, '__init__.py'), 'utf8');
    assert.match(init, /def register\(ctx\)/);
    assert.match(init, /register_hook\("pre_tool_call"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('hermes uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('hermes', home, cwd, 'install').status, 0);
    const res = run('hermes', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.hermes', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.hermes', 'huaweicloud-plugins')));
    const allowlistPath = join(home, '.hermes', 'shell-hooks-allowlist.json');
    if (existsSync(allowlistPath)) {
      const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
      const remains = (allowlist.approvals || []).some((a) => {
        const cmd = typeof a === 'string' ? a : a?.command;
        return typeof cmd === 'string' && cmd.includes('huaweicloud-safety.py');
      });
      assert.ok(!remains, 'uninstall must remove the safety hook approval from the allowlist');
    }
    assert.ok(
      !existsSync(join(home, '.hermes', 'plugins', 'huaweicloud-safety')),
      'uninstall must remove the safety hook plugin',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode install creates skills, MCP server, and safety policy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const res = run('atomcode', home, cwd, 'install');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[AtomCode\]/);
    assert.match(res.stdout, /Installation complete/);
    assert.ok(countSkills(join(home, '.atomcode', 'skills')) >= 6);
    const pd = join(home, '.atomcode', 'huaweicloud-plugins');
    assert.ok(existsSync(join(pd, 'src', 'mcp-server.mjs')));
    assert.ok(existsSync(join(pd, 'src', 'tools.mjs')));
    assert.ok(existsSync(join(pd, 'safety', 'policy.json')));
    assert.equal(pluginVersion(pd), pkg.version);
    const mcpCfg = JSON.parse(readFileSync(join(home, '.atomcode', 'mcp.json'), 'utf8'));
    assert.equal(mcpCfg.mcpServers['huaweicloud-devkit'].command, 'node');
    assert.ok(mcpCfg.mcpServers['huaweicloud-devkit'].args[0].endsWith('huaweicloud-plugins/src/mcp-server.mjs'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode status reports installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    const res = run('atomcode', home, cwd, 'status');
    assert.match(res.stdout, /MCP Server:.*Installed/);
    assert.match(res.stdout, /Skills:.*\d+ installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode uninstall removes installed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    const res = run('atomcode', home, cwd, 'uninstall');
    assert.match(res.stdout, /Uninstall complete/);
    assert.equal(countSkills(join(home, '.atomcode', 'skills')), 0);
    assert.ok(!existsSync(join(home, '.atomcode', 'huaweicloud-plugins')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomcode install is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    assert.equal(run('atomcode', home, cwd, 'install').status, 0);
    assert.ok(countSkills(join(home, '.atomcode', 'skills')) >= 6);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex target does not crash without Codex CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const emptyPath = join(cwd, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });
    const res = run('codex', home, cwd, 'install', { PATH: emptyPath });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Codex CLI not found/);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install uses DevKit plugin id and skips OpenCode marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd);
    const res = run('codex', home, cwd, 'install', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /@huaweicloud-devkit/);
    assert.match(res.stdout, /Installation complete/);

    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /"plugin","add","huaweicloud-devkit@huaweicloud-devkit"/);
    assert.doesNotMatch(log, /huaweicloud-core@huaweicloud-devkit/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex install fails fast when plugin add fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd, { failPluginAdd: true });
    const res = run('codex', home, cwd, 'install', env);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Codex plugin installation failed/);
    assert.match(res.stdout, /Installation failed for: codex/);
    assert.doesNotMatch(res.stdout, /Installation complete/);
    assert.ok(!existsSync(join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('codex status recognizes current and legacy plugin names', () => {
  for (const listOutput of ['huaweicloud-devkit@huaweicloud-devkit', 'huaweicloud-core@huaweicloud-devkit']) {
    const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
    try {
      const env = fakeCodexEnv(cwd, { listOutput });
      const res = run('codex', home, cwd, 'status', env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Plugin:.*Installed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('codex uninstall removes current and legacy plugin ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ai-proj-'));
  try {
    const env = fakeCodexEnv(cwd);
    const res = run('codex', home, cwd, 'uninstall', env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Removing Codex plugin: huaweicloud-devkit@huaweicloud-devkit/);
    assert.match(res.stdout, /Removing Codex plugin: huaweicloud-core@huaweicloud-devkit/);

    const log = readFileSync(env.logPath, 'utf8');
    assert.match(log, /"plugin","remove","huaweicloud-devkit@huaweicloud-devkit"/);
    assert.match(log, /"plugin","remove","huaweicloud-core@huaweicloud-devkit"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
