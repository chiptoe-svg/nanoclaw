/**
 * Applies fixTelegramRichText to every Telegram bot's outbound chat text.
 *
 * Lives outside telegram.ts because the add-telegram skill refresh replaces
 * that file with the channels-branch copy, and it registers from the modules
 * barrel because the refresh reads every channel-barrel import as a channel
 * skill. It re-registers each Telegram adapter with a factory that wraps
 * deliver(), keeping the original factory and defaults.
 */
import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  getChannelDefaults,
  getRegisteredChannelNames,
  registerChannelAdapter,
} from '../../channels/channel-registry.js';
import { createTelegramBridge, telegramInstanceBridgeFactory } from '../../channels/telegram.js';
import { fixTelegramRichText } from '../../channels/telegram-rich-text.js';

/** Same messages the bridge's transformOutboundText would see: plain chat text and text edits. */
export function fixOutboundMessage(message: OutboundMessage): OutboundMessage {
  const content = message.content;
  if (!content || typeof content !== 'object') return message;
  const c = content as Record<string, unknown>;
  if (c.type !== undefined || c.terminalCard) return message;
  if (c.operation !== undefined && c.operation !== 'edit') return message;
  const fixed = { ...c };
  for (const key of ['text', 'markdown'] as const) {
    if (typeof fixed[key] === 'string') fixed[key] = fixTelegramRichText(fixed[key] as string);
  }
  return { ...message, content: fixed };
}

export function withTelegramRichText(adapter: ChannelAdapter | null): ChannelAdapter | null {
  if (!adapter) return adapter;
  const deliver = adapter.deliver.bind(adapter);
  adapter.deliver = (platformId, threadId, message) => deliver(platformId, threadId, fixOutboundMessage(message));
  return adapter;
}

for (const name of getRegisteredChannelNames()) {
  if (name !== 'telegram' && !name.startsWith('telegram-')) continue;
  const factory =
    name === 'telegram'
      ? () => createTelegramBridge()
      : () => telegramInstanceBridgeFactory(name.slice('telegram-'.length));
  registerChannelAdapter(name, {
    factory: () => withTelegramRichText(factory()),
    defaults: getChannelDefaults(name),
  });
}
