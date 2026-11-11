import { createHash } from "node:crypto";

/**
 * Small bounded cache of SDK clients keyed by a SHA-256 fingerprint of the API key,
 * so per-organization keys get their own client without keeping a map keyed by the
 * plaintext key. Evicts the oldest entry when full.
 */
export class ClientCache<T> {
  private readonly clients = new Map<string, T>();
  constructor(private readonly max = 64) {}

  get(apiKey: string, create: () => T): T {
    const fp = keyFingerprint(apiKey);
    let c = this.clients.get(fp);
    if (c) {
      this.clients.delete(fp);
      this.clients.set(fp, c);
      return c;
    }
    c = create();
    this.clients.set(fp, c);
    if (this.clients.size > this.max) this.clients.delete(this.clients.keys().next().value!);
    return c;
  }
}

/** Non-reversible fingerprint of a key: safe to log or compare. */
export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}
