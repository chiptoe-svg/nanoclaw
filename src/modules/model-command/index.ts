/**
 * /model chat command — owner-only model switch for the agent wired to the
 * chat the command was sent from.
 *
 *   /model            show the current model and the aliases
 *   /model opus       switch (also: sonnet, haiku, fable, a full claude-* id)
 *   /model default    clear the override and follow the install default
 *
 * Saves the group's container config and restarts its running containers;
 * the session resumes on the new model with the next message. Runs as a
 * message interceptor, so the command never reaches the agent.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { DEFAULT_MODEL } from '../../config.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import { isOwner } from '../permissions/db/user-roles.js';

const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

const COMMAND = /^\/model(?:@\S+)?(?:\s+(\S+))?\s*$/i;

function parseContent(event: InboundEvent): Record<string, unknown> | null {
  try {
    return JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Same sender resolution as the permissions module: senderId, sender, or chat-sdk author.userId. */
function senderUserId(event: InboundEvent, content: Record<string, unknown>): string | null {
  const author = (typeof content.author === 'object' && content.author) as Record<string, unknown> | false;
  const raw =
    (typeof content.senderId === 'string' && content.senderId) ||
    (typeof content.sender === 'string' && content.sender) ||
    (author && typeof author.userId === 'string' && author.userId) ||
    null;
  if (!raw) return null;
  return raw.includes(':') ? raw : `${event.channelType}:${raw}`;
}

async function reply(event: InboundEvent, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  await adapter.deliver(
    event.channelType,
    event.platformId,
    event.threadId,
    'chat-sdk',
    JSON.stringify({ text }),
    undefined,
    event.instance,
  );
}

function describe(model: string | null | undefined): string {
  if (model) return model;
  return DEFAULT_MODEL ? `${DEFAULT_MODEL} (install default)` : 'SDK default (no model set)';
}

registerMessageInterceptor(async (event) => {
  const content = parseContent(event);
  const text = typeof content?.text === 'string' ? content.text.trim() : '';
  const match = COMMAND.exec(text);
  if (!content || !match) return false;

  const userId = senderUserId(event, content);
  if (!userId || !(await isOwner(userId))) {
    await reply(event, 'Only the owner can change the model.');
    return true;
  }

  const mg = await getMessagingGroupByPlatform(event.channelType, event.platformId, event.instance);
  const wirings = mg ? await getMessagingGroupAgents(mg.id) : [];
  if (wirings.length === 0) return false;
  const agentGroupIds = [...new Set(wirings.map((w) => w.agent_group_id))];

  const arg = match[1]?.toLowerCase();
  if (!arg) {
    const lines = await Promise.all(agentGroupIds.map(async (id) => describe((await getContainerConfig(id))?.model)));
    const aliases = Object.entries(ALIASES)
      .map(([k, v]) => `${k} → ${v}`)
      .join('\n');
    await reply(
      event,
      `Current model: ${lines.join(', ')}\n\nSwitch with /model <name>:\n${aliases}\ndefault → clear override`,
    );
    return true;
  }

  const model = arg === 'default' ? null : (ALIASES[arg] ?? (arg.startsWith('claude-') ? arg : undefined));
  if (model === undefined) {
    await reply(
      event,
      `Unknown model "${match[1]}". Use ${Object.keys(ALIASES).join(', ')}, default, or a full claude-* id.`,
    );
    return true;
  }

  for (const id of agentGroupIds) {
    await updateContainerConfigScalars(id, { model });
    await restartAgentGroupContainers(id, `model changed to ${model ?? 'default'} via /model`);
  }
  log.info('Model changed via /model', { userId, agentGroupIds, model });
  await reply(event, `Switched to ${describe(model)}. Your next message will use it.`);
  return true;
});
