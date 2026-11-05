/**
 * Precheck + hold builder for propose_skill.
 *
 * The approver must read the whole skill, and an approval card holds at most
 * 2,000 characters, so the full SKILL.md goes to the approver's DM as a plain
 * message first and the card that follows carries the summary and the
 * content hash the approval binds to.
 */
import { escapeInvisibles, quoteForCard } from '../../card-text.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { approvalCardThread, pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { registryView, storePaths } from './store.js';
import { parseFrontmatter, parseProposal, sha256, similarity, type SkillProposal } from './validate.js';

/** Validate against the live registry; tell the agent why on failure. */
export async function checkProposal(content: Record<string, unknown>, session: Session): Promise<SkillProposal | null> {
  let result;
  try {
    result = parseProposal(content, registryView(storePaths(session.agent_group_id)));
  } catch (err) {
    log.error('propose_skill: registry unreadable', { agentGroupId: session.agent_group_id, err });
    await notifyAgent(session, 'propose_skill failed: the skill registry could not be read.');
    return null;
  }
  if (!result.ok) {
    await notifyAgent(session, `propose_skill failed: ${result.error}.`);
    return null;
  }
  return result.proposal;
}

export async function validateProposeSkill(content: Record<string, unknown>, session: Session): Promise<boolean> {
  return (await checkProposal(content, session)) !== null;
}

/** A code fence longer than any backtick run inside `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(longest + 1);
}

function lineDelta(before: string, after: string): string {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  const added = [...b].filter((l) => !a.has(l)).length;
  const removed = [...a].filter((l) => !b.has(l)).length;
  return `+${added} / -${removed} lines`;
}

export async function requestProposeSkillHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const proposal = await checkProposal(content, session);
  if (!proposal) return;
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const approvers = await pickApprover(session.agent_group_id);
  const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const target = await pickApprovalDelivery(approvers, origin?.channel_type ?? '', origin?.instance);
  if (!target) {
    await notifyAgent(session, 'propose_skill failed: no owner or admin reachable to approve.');
    return;
  }

  const { op, name, rationale } = proposal;
  const lines = [
    `Agent ${quoteForCard(agentGroup.name)} wants to ${op} the skill ${escapeInvisibles(JSON.stringify(name))}.`,
  ];
  let previous: string | undefined;
  if (proposal.content !== null) {
    const description = parseFrontmatter(proposal.content)?.description ?? '';
    lines.push(`Description: ${quoteForCard(description)}`);
    if (op === 'update') {
      previous = registryView(storePaths(session.agent_group_id)).active.get(name);
      if (previous !== undefined) {
        lines.push(
          `Change: ${lineDelta(previous, proposal.content)} (similarity ${similarity(previous, proposal.content).toFixed(2)})`,
        );
      }
    }
    lines.push(`Size: ${proposal.content.length} characters, sha256 ${sha256(proposal.content).slice(0, 12)}`);
    lines.push('The full text is in the message above this card.');
  }
  lines.push(`Why: ${quoteForCard(rationale)}`);

  if (proposal.content !== null) {
    const adapter = getDeliveryAdapter();
    if (!adapter) {
      await notifyAgent(session, 'propose_skill failed: no delivery adapter to show the skill to an approver.');
      return;
    }
    const fence = fenceFor(proposal.content);
    const text =
      `Proposed skill (${op}) from ${agentGroup.name}: ${name}, sha256 ${sha256(proposal.content).slice(0, 12)}\n\n` +
      `${fence}markdown\n${proposal.content}\n${fence}`;
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        approvalCardThread(session, target.messagingGroup),
        'chat',
        JSON.stringify({ text }),
        undefined,
        target.messagingGroup.instance,
      );
    } catch (err) {
      log.error('propose_skill: could not deliver the skill text', { name, err });
      await notifyAgent(session, 'propose_skill failed: could not show the skill to an approver.');
      return;
    }
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'propose_skill',
    approverUserId: target.userId,
    // Only validated fields: the replay re-validates exactly what was shown.
    payload: { op, name, content: proposal.content, rationale, base_sha256: proposal.baseSha },
    title: `Skill ${op}: ${name}`,
    question: lines.join('\n'),
  });
}
