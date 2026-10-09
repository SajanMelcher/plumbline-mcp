export class UpstreamError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

const UA = "plumbline-mcp/0.1 (read-only DeepBook market data)";

/** GET/POST JSON with a hard timeout and readable errors. Never sends credentials. */
export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs: number; method?: "GET" | "POST"; body?: unknown; label: string },
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        "user-agent": UA,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new UpstreamError(`${opts.label} timed out after ${opts.timeoutMs} ms`);
    }
    throw new UpstreamError(`${opts.label} unreachable: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new UpstreamError(`${opts.label} returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(`${opts.label} returned non-JSON response`);
  }
}
