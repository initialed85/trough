// Wire format and shared types. See docs/PROTOCOL.md for the design and
// docs/ARCHITECTURE.md for how these map onto the code.
//
// One protocol message ("envelope") travels as:
//   - zero or more TAGMSG chunks carrying the structured payload as base64url JSON
//     in `+tr/d`, numbered with `+tr/part=i/n` (invisible to ordinary IRC clients), then
//   - an optional PRIVMSG carrying the human-readable text.
// Every IRC line of one envelope shares the same `+tr/id`.

import { randomBytes } from "node:crypto";

export const TAG_PREFIX = "+tr/";
export const LOBBY = "#trough";
export const STEWARDS_CHANNEL = "#trough-stewards";
export const STEWARD_HANDLE = "steward";
export const STEWARD_ACCOUNT = "trough-steward";
export const MAX_TEXT = 500;
// Raw bytes of JSON per chunk. Base64 inflates by 4/3, keeping each tag well under
// Ergo's 4094-byte client-tag budget.
const CHUNK_BYTES = 2000;

// The nine kinds from docs/PROTOCOL.md, plus three internal ones:
//   ack     - steward -> session: "filed", carries card id / default sharing
//   control - session/cli -> own steward: share, unshare, default-shared, review
//   note    - steward -> own session: a proactive-relevance hit
export const KINDS = [
  "hello", "update", "ask", "reply", "steer", "delegate", "checkpoint", "recall", "retract",
  "ack", "control", "note",
] as const;
export type Kind = (typeof KINDS)[number];

export interface Envelope {
  kind: Kind;
  id: string;
  /** id of the envelope this answers */
  re?: string;
  card?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface Received extends Envelope {
  from: string;
  /** server-verified account (IRCv3 account-tag); undefined if not logged in */
  account?: string;
  target: string;
  time: string;
}

export function newId(): string {
  return randomBytes(6).toString("base64url");
}

// --- nicks --------------------------------------------------------------------

const PRINCIPAL_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,14}$/;

export interface Nick {
  principal: string;
  handle: string;
}

export function formatNick(principal: string, handle: string): string {
  if (!PRINCIPAL_RE.test(principal)) throw new Error(`invalid principal: ${principal}`);
  if (!HANDLE_RE.test(handle)) throw new Error(`invalid handle: ${handle}`);
  return `${principal}|${handle}`;
}

export function parseNick(nick: string): Nick | undefined {
  const [principal, handle, ...rest] = nick.toLowerCase().split("|");
  if (rest.length || !principal || !handle) return undefined;
  if (!PRINCIPAL_RE.test(principal) || !HANDLE_RE.test(handle)) return undefined;
  return { principal, handle };
}

export function stewardNick(principal: string): string {
  return formatNick(principal, STEWARD_HANDLE);
}

/**
 * Is this message really from who its nick claims? Sessions must be logged in to their
 * principal's account; stewards to the shared steward service account. Anything else is
 * treated as an unauthenticated human or bot and gets no protocol trust.
 */
export function isAuthentic(nick: string, account: string | undefined): boolean {
  const parsed = parseNick(nick);
  if (!parsed || !account) return false;
  if (parsed.handle === STEWARD_HANDLE) return account === STEWARD_ACCOUNT;
  return account.toLowerCase() === parsed.principal;
}

// --- tags ---------------------------------------------------------------------

export function escapeTag(value: string): string {
  return value.replace(/[\\; \r\n]/g, (c) => ({ "\\": "\\\\", ";": "\\:", " ": "\\s", "\r": "\\r", "\n": "\\n" })[c]!);
}

export function unescapeTag(value: string): string {
  return value.replace(/\\(.?)/g, (_, c: string) => ({ ":": ";", s: " ", r: "\r", n: "\n", "\\": "\\" })[c] ?? c);
}

export function formatTags(tags: Record<string, string>): string {
  const parts = Object.entries(tags).map(([k, v]) => (v === "" ? k : `${k}=${escapeTag(v)}`));
  return parts.length ? `@${parts.join(";")} ` : "";
}

// --- envelope <-> IRC lines -----------------------------------------------------

/** Encode an envelope into raw IRC lines addressed to `target`. */
export function encodeEnvelope(target: string, env: Envelope): string[] {
  const base: Record<string, string> = { [`${TAG_PREFIX}kind`]: env.kind, [`${TAG_PREFIX}id`]: env.id };
  if (env.re) base[`${TAG_PREFIX}re`] = env.re;
  if (env.card) base[`${TAG_PREFIX}card`] = env.card;
  const lines: string[] = [];
  const text = env.text ? sanitiseText(env.text) : "";
  if (env.data && Object.keys(env.data).length) {
    const raw = Buffer.from(JSON.stringify(env.data));
    const total = Math.max(1, Math.ceil(raw.length / CHUNK_BYTES));
    for (let i = 0; i < total; i++) {
      const tags: Record<string, string> = { ...base, [`${TAG_PREFIX}part`]: `${i + 1}/${total}`, [`${TAG_PREFIX}d`]: raw.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString("base64url") };
      if (i === total - 1 && text) tags[`${TAG_PREFIX}t`] = "1";
      lines.push(`${formatTags(tags)}TAGMSG ${target}`);
    }
  }
  if (text) lines.push(`${formatTags(base)}PRIVMSG ${target} :${text}`);
  if (!lines.length) lines.push(`${formatTags(base)}TAGMSG ${target}`);
  return lines;
}

function sanitiseText(text: string): string {
  // IRC bodies are single-line; keep the human-readable part short and readable.
  const flat = text.replace(/\s*\r?\n\s*/g, " / ").trim();
  return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}

export interface IrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

interface Pending {
  parts: string[];
  total: number;
  got: number;
  expectText: boolean;
  text?: string;
  textSeen: boolean;
  firstAt: number;
}

/**
 * Reassembles envelopes from IRC messages. Feed it every TAGMSG/PRIVMSG; it returns a
 * Received once an envelope is complete. Lines without `+tr/kind` are returned as plain
 * chat (kind undefined) so callers can show humans' messages in the drawer.
 */
export class Assembler {
  private pending = new Map<string, Pending>();

  push(msg: IrcMessage): Received | { plain: true; from: string; account?: string; target: string; text: string; time: string } | undefined {
    if (msg.command !== "PRIVMSG" && msg.command !== "TAGMSG") return undefined;
    const from = (msg.prefix ?? "").split("!")[0] ?? "";
    const target = msg.params[0] ?? "";
    const account = msg.tags["account"];
    const time = msg.tags["time"] ?? new Date().toISOString();
    const kind = msg.tags[`${TAG_PREFIX}kind`] as Kind | undefined;
    if (!kind || !(KINDS as readonly string[]).includes(kind)) {
      if (msg.command === "PRIVMSG") return { plain: true, from, account, target, text: msg.params[1] ?? "", time };
      return undefined;
    }
    const id = msg.tags[`${TAG_PREFIX}id`] ?? "";
    const key = `${from}\u0000${id}`;
    this.gc();
    let p = this.pending.get(key);
    const part = msg.tags[`${TAG_PREFIX}part`];
    if (msg.command === "TAGMSG" && part) {
      const [i, n] = part.split("/").map(Number);
      if (!i || !n) return undefined;
      p ??= { parts: new Array(n), total: n, got: 0, expectText: false, textSeen: false, firstAt: Date.now() };
      if (p.parts[i - 1] === undefined) p.got++;
      p.parts[i - 1] = msg.tags[`${TAG_PREFIX}d`] ?? "";
      if (msg.tags[`${TAG_PREFIX}t`] === "1") p.expectText = true;
      this.pending.set(key, p);
    } else if (msg.command === "PRIVMSG") {
      if (!p) {
        // Text-only envelope.
        return this.finish(kind, id, msg, from, account, target, time, undefined, msg.params[1]);
      }
      p.text = msg.params[1];
      p.textSeen = true;
    } else {
      // Bare TAGMSG with no payload.
      return this.finish(kind, id, msg, from, account, target, time, undefined, undefined);
    }
    if (p.got === p.total && (!p.expectText || p.textSeen)) {
      this.pending.delete(key);
      // Each chunk was base64url-encoded on its own, so decode per chunk, then join bytes.
      const json = Buffer.concat(p.parts.map((c) => Buffer.from(c, "base64url"))).toString("utf8");
      let data: Record<string, unknown> | undefined;
      try {
        data = JSON.parse(json) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      return this.finish(kind, id, msg, from, account, target, time, data, p.text);
    }
    return undefined;
  }

  private finish(kind: Kind, id: string, msg: IrcMessage, from: string, account: string | undefined, target: string, time: string, data: Record<string, unknown> | undefined, text: string | undefined): Received {
    const env: Received = { kind, id, from, account, target, time };
    const re = msg.tags[`${TAG_PREFIX}re`];
    const card = msg.tags[`${TAG_PREFIX}card`];
    if (re) env.re = re;
    if (card) env.card = card;
    if (data) env.data = data;
    if (text) env.text = text;
    return env;
  }

  private gc(): void {
    const cutoff = Date.now() - 60_000;
    for (const [k, p] of this.pending) if (p.firstAt < cutoff) this.pending.delete(k);
  }
}

export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(m|h|d|w)?$/i.exec(s.trim());
  if (!m) return 24 * 3600_000;
  const n = Number(m[1]);
  const unit = (m[2] ?? "d").toLowerCase();
  return n * ({ m: 60_000, h: 3600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>)[unit]!;
}

// --- domain types ---------------------------------------------------------------

export const CARD_KINDS = ["task", "pr-review", "incident", "component"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** Which ref type, if any, is the identity key for each card kind. */
export const KIND_KEY: Record<CardKind, string | undefined> = {
  task: undefined,
  "pr-review": "pr",
  incident: undefined,
  component: "component",
};

export interface Ref {
  type: string;
  value: string;
  label?: string;
  note?: string;
}

export interface Recipe {
  command: string;
  purpose: string;
  preconditions?: string;
  output?: string;
  gotchas?: string;
  refs?: Ref[];
  verified?: string;
  danger?: boolean;
}

export type ReviewMode = "review" | "auto-after" | "auto";
export type RelevanceLevel = "off" | "refs" | "assisted";

export interface Hello {
  agent: string;
  role?: string;
  focus?: string;
  cards?: string[];
  shared?: boolean;
}
