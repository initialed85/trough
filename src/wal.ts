// Client-side write-ahead log. Checkpoints and updates are appended here before they're
// sent, and only dropped once the steward acks them, so the session never blocks on the
// steward and nothing is lost if the steward (or IRC) is down. Envelope ids make replay
// idempotent: the steward ignores ids it has already filed.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope } from "./protocol.ts";

interface Entry {
  target: string;
  env: Envelope;
  at: string;
}

export class Wal {
  readonly path: string;
  private pending = new Map<string, Entry>();

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.load();
  }

  private load(): void {
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { ack?: string } & Partial<Entry>;
        if (rec.ack) this.pending.delete(rec.ack);
        else if (rec.env && rec.target) this.pending.set(rec.env.id, rec as Entry);
      } catch {
        // a torn final line from a crash; skip it
      }
    }
    this.compact();
  }

  /** Rewrite the file with only unacked entries. */
  compact(): void {
    const lines = [...this.pending.values()].map((e) => JSON.stringify(e));
    writeFileSync(this.path, lines.length ? `${lines.join("\n")}\n` : "");
  }

  append(target: string, env: Envelope): void {
    const entry: Entry = { target, env, at: new Date().toISOString() };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.pending.set(env.id, entry);
  }

  ack(id: string): void {
    if (!this.pending.delete(id)) return;
    appendFileSync(this.path, `${JSON.stringify({ ack: id })}\n`);
  }

  unacked(): Entry[] {
    return [...this.pending.values()];
  }
}
