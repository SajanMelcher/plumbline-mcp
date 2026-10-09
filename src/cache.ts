/** Tiny TTL cache with in-flight request de-duplication and a hard size cap. */
export class TtlCache {
  private store = new Map<string, { value: unknown; expires: number }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private maxEntries = 256) {}

  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expires > now) return hit.value as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = loader()
      .then((value) => {
        if (ttlMs > 0) {
          this.store.delete(key); // refresh insertion order
          this.store.set(key, { value, expires: Date.now() + ttlMs });
          while (this.store.size > this.maxEntries) {
            const oldest = this.store.keys().next().value;
            if (oldest === undefined) break;
            this.store.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.store.clear();
  }
}
