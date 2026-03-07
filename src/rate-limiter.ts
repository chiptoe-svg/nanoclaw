export class RateLimiter {
  private windows: Map<string, number[]> = new Map();
  private checkCount = 0;

  constructor(
    private readonly maxTriggers: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record a trigger attempt and return whether it is allowed.
   * Returns true if under the limit, false if the window is exhausted.
   * Lazily trims stale keys every 100 calls.
   */
  check(chatJid: string, sender: string): boolean {
    const key = `${chatJid}:${sender}`;
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const raw = this.windows.get(key);
    const timestamps = raw ? raw.filter((t) => t > cutoff) : [];

    if (timestamps.length >= this.maxTriggers) {
      this.windows.set(key, timestamps);
      this.maybeAutoTrim();
      return false;
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    this.maybeAutoTrim();
    return true;
  }

  /**
   * Evict all entries whose entire window has expired.
   * Call periodically to prevent unbounded map growth.
   */
  trim(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const filtered = timestamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, filtered);
      }
    }
  }

  private maybeAutoTrim(): void {
    this.checkCount++;
    if (this.checkCount % 100 === 0) {
      this.trim();
    }
  }
}
