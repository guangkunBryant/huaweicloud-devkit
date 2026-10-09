import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const skillsDir = join(root, 'plugins', 'huaweicloud-core', 'skills');

// SKILL.md is the compact routing layer (~80 lines target); anything beyond
// MAX_LINES usually means knowledge was copied into the skill instead of
// pointing at official docs. This test guards that invariant.
const MAX_LINES = 200;

const requiredMetaSkills = [
  'huaweicloud-api-and-sdk',
  'huaweicloud-capability-discovery',
  'huaweicloud-cli-and-auth',
  'huaweicloud-core',
  'huaweicloud-safety',
  'huaweicloud-troubleshooting',
];

for (const name of requiredMetaSkills) {
  test(`meta-skill-length: ${name}/SKILL.md stays within ${MAX_LINES} lines`, () => {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const lines = body.split('\n').length;
    assert.ok(
      lines <= MAX_LINES,
      `${name}/SKILL.md has ${lines} lines (max ${MAX_LINES}) — move detailed content to references/`,
    );
  });
}
