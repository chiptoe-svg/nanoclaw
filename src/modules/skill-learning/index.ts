/**
 * Skill-learning module — agent-proposed skills, admin-approved.
 *
 * The agent drafts a skill from work it just did and proposes it with the
 * `propose_skill` MCP tool (create / update / archive). On install this
 * module registers:
 *   - Its guard-catalog entry (./guard.ts): unconditional hold from the
 *     container path.
 *   - The guard-wrapped delivery action: validation (./validate.ts) as the
 *     precheck, the hold builder (./request.ts) shows the approver the full
 *     text and cards them, and the body (./apply.ts) installs the skill on
 *     an approved replay.
 *   - The approval handler, which re-enters the wrapped action and records
 *     who approved.
 *
 * Every approved version is kept host-side with a ledger (./store.ts), so
 * any change can be diffed or rolled back with scripts/skill-learning.ts.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyProposeSkill } from './apply.js';
import { skillLearningPropose } from './guard.js';
import { requestProposeSkillHold, validateProposeSkill } from './request.js';

registerDeliveryAction('propose_skill', applyProposeSkill, {
  guardAction: skillLearningPropose,
  precheck: validateProposeSkill,
  requestHold: requestProposeSkillHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `propose_skill denied: ${reason}`),
});

const replay = reenterGuardedDeliveryAction('propose_skill');
registerApprovalHandler('propose_skill', (ctx) =>
  replay({ ...ctx, payload: { ...ctx.payload, approved_by: ctx.userId } }),
);
