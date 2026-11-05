/**
 * Guarded handler body for propose_skill — runs only on an approved replay
 * (the guard holds every container-path request; see ./guard.ts), after the
 * precheck re-validated the payload against the live registry.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { checkProposal } from './request.js';
import { applyChange, storePaths } from './store.js';

export async function applyProposeSkill(payload: Record<string, unknown>, session: Session): Promise<void> {
  const proposal = await checkProposal(payload, session);
  if (!proposal) return;
  const actor = typeof payload.approved_by === 'string' ? payload.approved_by : 'admin';

  let result;
  try {
    result = applyChange(storePaths(session.agent_group_id), proposal, { actor, sessionId: session.id });
  } catch (err) {
    log.error('propose_skill: apply failed', { name: proposal.name, err });
    await notifyAgent(
      session,
      `propose_skill approved, but writing "${proposal.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  log.info('Learned skill changed', {
    agentGroupId: session.agent_group_id,
    op: proposal.op,
    name: proposal.name,
    version: result.version,
    drift: result.drift,
  });

  const notes: string[] = [];
  if (result.drift)
    notes.push(
      'The installed copy had been edited outside approval; that edit is kept in the ledger and is now replaced.',
    );
  if (result.leftovers.length > 0) notes.push(`Left in place (subdirectories): ${result.leftovers.join(', ')}.`);
  const done =
    proposal.op === 'archive'
      ? `Skill "${proposal.name}" archived.`
      : `Skill "${proposal.name}" ${proposal.op === 'create' ? 'installed' : 'updated'} (v${result.version}) at ~/.claude/skills/${proposal.name}/SKILL.md.`;
  await notifyAgent(session, [done, ...notes].join(' '));
}
