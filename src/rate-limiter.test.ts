import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows triggers up to the max', () => {
    const rl = new RateLimiter(3, 60000);
    expect(rl.check('chat', 'alice')).toBe(true);
    expect(rl.check('chat', 'alice')).toBe(true);
    expect(rl.check('chat', 'alice')).toBe(true);
  });

  it('blocks triggers exceeding the max', () => {
    const rl = new RateLimiter(3, 60000);
    rl.check('chat', 'alice');
    rl.check('chat', 'alice');
    rl.check('chat', 'alice');
    expect(rl.check('chat', 'alice')).toBe(false);
    expect(rl.check('chat', 'alice')).toBe(false);
  });

  it('resets after the window expires', () => {
    const rl = new RateLimiter(2, 60000);
    rl.check('chat', 'alice');
    rl.check('chat', 'alice');
    expect(rl.check('chat', 'alice')).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(60001);
    expect(rl.check('chat', 'alice')).toBe(true);
  });

  it('tracks senders independently within the same chat', () => {
    const rl = new RateLimiter(1, 60000);
    expect(rl.check('chat', 'alice')).toBe(true);
    expect(rl.check('chat', 'alice')).toBe(false);
    // bob is a separate key — unaffected by alice's limit
    expect(rl.check('chat', 'bob')).toBe(true);
  });

  it('tracks chats independently for the same sender', () => {
    const rl = new RateLimiter(1, 60000);
    expect(rl.check('chat-a', 'alice')).toBe(true);
    expect(rl.check('chat-a', 'alice')).toBe(false);
    // Same sender, different chat — separate window
    expect(rl.check('chat-b', 'alice')).toBe(true);
  });

  it('allows exactly maxTriggers before blocking', () => {
    const rl = new RateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      expect(rl.check('chat', 'user')).toBe(true);
    }
    expect(rl.check('chat', 'user')).toBe(false);
  });

  it('sliding window: only counts triggers within the window', () => {
    const rl = new RateLimiter(3, 60000);
    // Use 2 of 3 slots
    rl.check('chat', 'alice');
    rl.check('chat', 'alice');

    // Advance 30s — first two are now 30s old (still in window)
    vi.advanceTimersByTime(30000);

    // Use the last slot
    rl.check('chat', 'alice');
    expect(rl.check('chat', 'alice')).toBe(false);

    // Advance another 30s — first two timestamps drop out of 60s window
    vi.advanceTimersByTime(30001);
    // Now only the third trigger (30s ago) is in the window: 1 of 3, allowed
    expect(rl.check('chat', 'alice')).toBe(true);
  });
});

describe('RateLimiter.trim()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes entries whose window has fully expired', () => {
    const rl = new RateLimiter(5, 60000);
    rl.check('chat', 'alice');
    rl.check('chat', 'bob');

    // Expose internal map via cast for assertion
    const internal = (rl as unknown as { windows: Map<string, number[]> }).windows;
    expect(internal.size).toBe(2);

    vi.advanceTimersByTime(60001);
    rl.trim();
    expect(internal.size).toBe(0);
  });

  it('retains entries that still have timestamps in the window', () => {
    const rl = new RateLimiter(5, 60000);
    rl.check('chat', 'alice');
    vi.advanceTimersByTime(30000);
    rl.check('chat', 'alice'); // second trigger still within window after trim

    vi.advanceTimersByTime(31000); // first trigger now expired, second still valid
    rl.trim();

    const internal = (rl as unknown as { windows: Map<string, number[]> }).windows;
    expect(internal.size).toBe(1);
    expect(internal.get('chat:alice')!.length).toBe(1);
  });

  it('auto-trims stale keys every 100 checks', () => {
    const rl = new RateLimiter(200, 60000);
    // Create 50 distinct keys
    for (let i = 0; i < 50; i++) {
      rl.check('chat', `user-${i}`);
    }
    const internal = (rl as unknown as { windows: Map<string, number[]> }).windows;
    expect(internal.size).toBe(50);

    // Expire all entries
    vi.advanceTimersByTime(60001);

    // Trigger 50 more checks (total 100) — auto-trim fires on the 100th
    for (let i = 50; i < 100; i++) {
      rl.check('chat', `user-${i}`);
    }
    // The 50 expired keys should have been evicted; 50 new ones remain
    expect(internal.size).toBe(50);
  });
});
