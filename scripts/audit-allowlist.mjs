// Security audit gate with advisory allowlist.
//
// Usage (in CI): npm audit --audit-level=high --json > npm-audit.json || true
//                node scripts/audit-allowlist.mjs
//
// Exits 0 only when every remaining vulnerability traces (transitively
// through dependency chains) to an allowlisted advisory. Any non-allowlisted
// vulnerability fails the gate, so future advisories are still caught.

import { readFileSync } from 'node:fs';

// Advisories that are fixed nowhere upstream and risk-assessed as acceptable.
// Keep this list minimal, dated, and justified:
//
// - GHSA-vfj7-8cjw-p6xm (braces <= 3.0.3): stack-exhaustion DoS in recursive
//   AST walkers. No fixed version exists (3.0.3 is the latest release).
//   Dev-only transitive dependency of markdownlint-cli2 lint tooling;
//   local-DoS risk only. Allowlisted 2026-10-09.
const ALLOWLIST = ['GHSA-vfj7-8cjw-p6xm'];

const audit = JSON.parse(readFileSync('npm-audit.json', 'utf8'));

// A via entry is either an advisory object ({ source: "GHSA-..." }) or a
// plain string naming a package the entry is vulnerable through.
const isBlocked = (via, seen = new Set()) => {
  if (typeof via === 'string') {
    if (seen.has(via)) return false; // cycle guard
    seen.add(via);
    const entry = audit.vulnerabilities[via];
    // Unknown package chain: treat as blocked (strict).
    return entry ? entry.via.some((v) => isBlocked(v, seen)) : true;
  }
  return !ALLOWLIST.includes(via.source);
};

const blocked = Object.entries(audit.vulnerabilities ?? {})
  .filter(([, v]) => (v.via ?? []).some((x) => isBlocked(x)))
  .map(([id]) => id);

if (blocked.length > 0) {
  console.error(`npm audit gate failed — non-allowlisted vulnerabilities: ${blocked.join(', ')}`);
  process.exit(1);
}

console.log('npm audit gate passed — only allowlisted advisories present.');
