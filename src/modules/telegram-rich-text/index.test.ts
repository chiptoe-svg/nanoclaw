import { describe, expect, it } from 'vitest';

import { fixOutboundMessage } from './index.js';

describe('fixOutboundMessage', () => {
  it('escapes plain chat text and edits', () => {
    expect(fixOutboundMessage({ kind: 'chat', content: { text: 'NVDA $186' } }).content).toEqual({
      text: 'NVDA \\$186',
    });
    expect(
      fixOutboundMessage({ kind: 'chat', content: { operation: 'edit', messageId: '1', text: '$5' } }).content,
    ).toEqual({ operation: 'edit', messageId: '1', text: '\\$5' });
  });

  it('leaves cards, questions, reactions and terminal cards alone', () => {
    for (const content of [
      { type: 'card', card: { title: '$5' } },
      { type: 'ask_question', questionId: 'q', options: [], title: '$5' },
      { operation: 'reaction', messageId: '1', emoji: '👍' },
      { operation: 'edit', messageId: '1', terminalCard: {}, text: '$5' },
    ]) {
      expect(fixOutboundMessage({ kind: 'chat', content }).content).toBe(content);
    }
  });
});
