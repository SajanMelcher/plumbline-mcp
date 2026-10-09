import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/** Bucket IPv6 by /64 (one subscriber usually controls a whole /64), strip IPv4-mapped prefixes. */
export function ipBucket(ip: string): string {
  const v = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIP(v) === 6) {
    const [head, tail = ""] = v.toLowerCase().split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return full.slice(0, 4).map((x) => x.padStart(4, "0")).join(":") + "::/64";
  }
  return v;
}

export interface ClientIdOptions {
  trustProxy: boolean;
  /** A header your edge proxy sets and overwrites, e.g. fly-client-ip or cf-connecting-ip. */
  clientIpHeader?: string;
}

/**
 * Identity for the free tier. Client-supplied headers are spoofable, so they are only used when the operator
 * says a proxy they control sits in front:
 *  - clientIpHeader: a single-value header the proxy overwrites (best);
 *  - trustProxy: the RIGHTMOST X-Forwarded-For entry, i.e. the one appended by the proxy (leftmost entries
 *    are client-controlled).
 * Otherwise the TCP peer address is used. Paid credits do not depend on this (they are bound to a token).
 */
export function clientIdFor(req: Pick<IncomingMessage, "headers" | "socket">, o: ClientIdOptions): string {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[v.length - 1] : v);
  if (o.clientIpHeader) {
    const v = pick(req.headers[o.clientIpHeader])?.trim();
    if (v && isIP(v.replace(/^::ffff:/i, ""))) return `ip:${ipBucket(v)}`;
  }
  if (o.trustProxy) {
    const parts = (pick(req.headers["x-forwarded-for"]) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && isIP(last.replace(/^::ffff:/i, ""))) return `ip:${ipBucket(last)}`;
  }
  return `ip:${ipBucket(req.socket.remoteAddress ?? "unknown")}`;
}

/** Fixed-window per-client request limiter for the HTTP transport (bounded memory). */
export class RateLimiter {
  private win = 0;
  private counts = new Map<string, number>();
  constructor(private readonly perMinute: number, private readonly maxKeys = 50_000) {}
  allow(key: string, now = Date.now()): boolean {
    if (this.perMinute <= 0) return true;
    const w = Math.floor(now / 60_000);
    if (w !== this.win) {
      this.win = w;
      this.counts.clear();
    }
    const n = this.counts.get(key) ?? 0;
    if (n >= this.perMinute) return false;
    if (n === 0 && this.counts.size >= this.maxKeys) return false;
    this.counts.set(key, n + 1);
    return true;
  }
}
