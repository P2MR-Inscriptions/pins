// SPDX-License-Identifier: Apache-2.0

/**
 * Results that depend only on the indexed state, kept until the tip changes.
 *
 * The key names the tip (height, block hash and state hash). The state of the indexer changes only when a
 * block is committed or disconnected, and either one changes the tip, so a new block or a reorg gives a new
 * key and drops every entry. Only the current key is kept, so the memory is bounded by the entries named by
 * the caller. Concurrent requests for one entry share one computation. A computation that fails is not kept.
 */
export class TipCache {
  private key = "";
  private readonly entries = new Map<string, Promise<unknown>>();
  hits = 0;
  misses = 0;

  get<T>(key: string, name: string, compute: () => T | Promise<T>): Promise<T> {
    if (key !== this.key) {
      this.key = key;
      this.entries.clear();
    }
    const kept = this.entries.get(name);
    if (kept) {
      this.hits += 1;
      return kept as Promise<T>;
    }
    this.misses += 1;
    const created = Promise.resolve().then(compute);
    this.entries.set(name, created);
    created.catch(() => {
      if (this.key === key && this.entries.get(name) === created) this.entries.delete(name);
    });
    return created;
  }
}
