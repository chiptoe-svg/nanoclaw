/**
 * scripts/skill-learning.ts — operator view of agent-learned skills.
 *
 * Usage:
 *   pnpm exec tsx scripts/skill-learning.ts list <agent-group-id>
 *   pnpm exec tsx scripts/skill-learning.ts history <agent-group-id> [name]
 *   pnpm exec tsx scripts/skill-learning.ts show <agent-group-id> <sha256-prefix>
 *   pnpm exec tsx scripts/skill-learning.ts rollback <agent-group-id> <name> <sha256-prefix>
 *
 * Reads host-only state under data/skill-learning/<group>/. Rollback is an
 * operator action: it reinstalls an approved version without a card and
 * records it in the ledger. The change reaches the agent on its next session.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  loadRegistry,
  readBlob,
  readInstalled,
  readLedger,
  rollbackTo,
  storePaths,
  type StorePaths,
} from '../src/modules/skill-learning/store.js';
import { sha256 } from '../src/modules/skill-learning/validate.js';

function usage(): never {
  console.error(
    'usage: skill-learning.ts list|history|show|rollback <agent-group-id> [...]\n' +
      '  list <group>                     learned skills and whether the installed copy matches approval\n' +
      '  history <group> [name]           ledger entries\n' +
      '  show <group> <sha-prefix>        print an approved version\n' +
      '  rollback <group> <name> <sha>    reinstall an approved version',
  );
  process.exit(2);
}

function resolveSha(p: StorePaths, prefix: string): string {
  const dir = path.join(p.stateDir, 'blobs');
  const matches = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.replace(/\.md$/, ''))
    : [];
  if (matches.length !== 1) {
    console.error(matches.length === 0 ? `no version matches ${prefix}` : `${prefix} is ambiguous`);
    process.exit(1);
  }
  return matches[0];
}

const [cmd, group, ...rest] = process.argv.slice(2);
if (!cmd || !group) usage();
const p = storePaths(group);

switch (cmd) {
  case 'list': {
    const registry = loadRegistry(p);
    const names = Object.keys(registry.skills).sort();
    if (names.length === 0) console.log('(no learned skills)');
    for (const name of names) {
      const rec = registry.skills[name];
      const installed = rec.status === 'active' ? readInstalled(p, name) : null;
      const state =
        rec.status === 'archived'
          ? 'archived'
          : installed === null
            ? 'MISSING'
            : sha256(installed) === rec.sha256
              ? 'ok'
              : 'EDITED outside approval';
      console.log(`${name}  v${rec.version}  ${rec.sha256.slice(0, 12)}  ${rec.updated_at}  ${state}`);
    }
    break;
  }
  case 'history': {
    const [name] = rest;
    for (const e of readLedger(p).filter((x) => !name || x.name === name)) {
      const shas = `${e.before_sha?.slice(0, 12) ?? '-'} -> ${e.after_sha?.slice(0, 12) ?? '-'}`;
      console.log(`${e.at}  ${e.op}  ${e.name}  v${e.version}  ${shas}${e.drift ? '  (drift)' : ''}  by ${e.actor}`);
      console.log(`    ${e.rationale}`);
    }
    break;
  }
  case 'show': {
    const [prefix] = rest;
    if (!prefix) usage();
    process.stdout.write(readBlob(p, resolveSha(p, prefix)));
    break;
  }
  case 'rollback': {
    const [name, prefix] = rest;
    if (!name || !prefix) usage();
    const result = rollbackTo(p, name, resolveSha(p, prefix), 'operator');
    console.log(
      `${name} rolled back (v${result.version})${result.drift ? '; the edited copy is kept in the ledger' : ''}`,
    );
    break;
  }
  default:
    usage();
}
