// Security audit gate with advisory allowlist.
//
// Usage (in CI): npm audit --audit-level=high --json > npm-audit.json || true
//                node scripts/audit-allowlist.mjs
//
// Preserves the original `npm audit --audit-level=high` semantics: fails when
// any advisory of high or greater severity exists in the tree, EXCEPT the
// explicitly allowlisted ones. Low/moderate advisories never fail the gate,
// and severity propagated through dependency chains is not attributed to
// child packages — only real advisories are judged.

import { readFileSync } from 'node:fs';

// Advisories that are fixed nowhere upstream and risk-assessed as acceptable.
// Keep this list minimal, dated, and justified:
//
// - GHSA-vfj7-8cjw-p6xm (braces <= 3.0.3): stack-exhaustion DoS in recursive
//   AST walkers. No fixed version exists (3.0.3 is the latest release).
//   Dev-only transitive dependency of markdownlint-cli2 lint tooling;
//   local-DoS risk only. Allowlisted 2026-10-09.
const ALLOWLIST = ['GHSA-vfj7-8cjw-p6xm'];

const audit = JSON.parse(readFileSync('npm-audit.json', 'utf8').replace(/^\uFEFF/, ''));
const SEVERITY_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

const isAllowlisted = (advisory) =>
  ALLOWLIST.includes(String(advisory.source)) ||
  (typeof advisory.url === 'string' && ALLOWLIST.some((id) => advisory.url.includes(id)));

const failing = [];
for (const entry of Object.values(audit.vulnerabilities ?? {})) {
  for (const via of entry.via ?? []) {
    // Advisory entries are objects ({ source, url, severity, ... });
    // dependency-chain entries are plain strings (judged via their own entry).
    if (typeof via !== 'object' || via.severity === undefined) continue;
    if (SEVERITY_RANK[via.severity] < SEVERITY_RANK.high) continue;
    if (isAllowlisted(via)) continue;
    failing.push(`${via.source ?? via.url ?? 'unknown'} (${via.name} ${via.severity})`);
  }
}

if (failing.length > 0) {
  console.error(`npm audit gate failed — non-allowlisted high+ advisories: ${failing.join(', ')}`);
  process.exit(1);
}

console.log('npm audit gate passed — no non-allowlisted high+ advisories.');
