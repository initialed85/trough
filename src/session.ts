// A live agent session on the trough: one IRC connection as `<principal>|<handle>`,
// a write-ahead log for checkpoints/updates, and the inject/drawer queues the client
// integrations (MCP server, hooks, Pi extension) read from.

import { EventEmitter } from "node:events";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ClientConfig } from "./config.ts";
import { troughHome } from "./config.ts";
import { classify, isDone, type Level, type Plain } from "./delivery.ts";
import { IrcClient } from "./irc.ts";
import { Assembler, LOBBY, cardChannel, MAX_TEXT, encodeEnvelope, formatNick, newId, parseNick, stewardNick, type Envelope, type Hello, type Received, type Ref } from "./protocol.ts";
import { scrub, scrubDeep } from "./scrub.ts";
import { Wal } from "./wal.ts";

export interface SessionOptions {
  config: ClientConfig;
  agent: string;
  role?: string;
  handle?: string;
  log?: (line: string) => void;
}

export interface Item {
  at: string;
  level: Level;
  from: string;
  kind: string;
  id?: string;
  re?: string;
  card?: string;
  text: string;
  data?: Record<string, unknown>;
}

const AGENT_PREFIX: Record<string, string> = { "claude-code": "cc", claude: "cc", codex: "cx", pi: "pi" };
const DRAWER_MAX = 200;

export function newHandle(agent: string): string {
  return `${AGENT_PREFIX[agent] ?? agent.replace(/[^a-z0-9]/g, "").slice(0, 4) ?? "ag"}-${randomBytes(2).toString("hex")}`;
}

/** Events: "steward" (first ack from our steward), "inject" (Item queued for the model). */
export class Session extends EventEmitter {
  readonly nick: string;
  readonly principal: string;
  readonly agent: string;
  readonly irc: IrcClient;
  readonly wal: Wal;
  role?: string;
  focus?: string;
  cards = new Set<string>();
  shared?: boolean;
  defaultShared?: boolean | null;
  chatter = false;
  /** Set when the server rejected our account; surfaced by the status action. */
  authError?: string;
  private inject: Item[] = [];
  private drawer: Item[] = [];
  private inbox = new Map<string, Item>();
  private waiting = new Map<string, (r: Received) => void>();
  private myRequests = new Set<string>();
  private asm = new Assembler();
  private helloTimer?: NodeJS.Timeout;
  /** Nicks present in #trough per NAMES/JOIN/PART/QUIT, so the roster isn't empty until the next hello round. */
  private present = new Set<string>();
  private directSends = new Map<string, { target: string; env: Envelope; at: number }>();
  /** msgids of our own channel messages (server echoes), so unshare can delete them from history. */
  private ownChannelMsgids: { target: string; msgid: string }[] = [];

  constructor(opts: SessionOptions) {
    super();
    this.principal = opts.config.principal;
    this.agent = opts.agent;
    this.role = opts.role;
    this.nick = formatNick(this.principal, opts.handle ?? newHandle(opts.agent));
    this.wal = new Wal(join(troughHome(), "wal", `${this.nick.replace("|", "_")}.jsonl`));
    this.irc = new IrcClient({
      host: opts.config.host,
      port: opts.config.port,
      tls: opts.config.tls,
      insecure: opts.config.insecure,
      nick: this.nick,
      account: this.principal,
      password: opts.config.password,
      channels: [LOBBY],
      log: opts.log,
    });
    this.irc.on("message", (m) => {
      this.trackPresence(m.command, (m.prefix ?? "").split("!")[0] ?? "", m.params);
      if (m.command === "401" && m.params[1]) this.onNoSuchNick(m.params[1]);
      const from = (m.prefix ?? "").split("!")[0]?.toLowerCase();
      if ((m.command === "PRIVMSG" || m.command === "TAGMSG") && from === this.irc.nick.toLowerCase() && m.params[0]?.startsWith("#") && m.tags.msgid) {
        this.ownChannelMsgids.push({ target: m.params[0], msgid: m.tags.msgid });
        if (this.ownChannelMsgids.length > 2000) this.ownChannelMsgids.splice(0, 1000);
      }
      const r = this.asm.push(m);
      if (r) this.onReceived(r as Received | Plain);
    });
    this.irc.on("registered", () => {
      this.hello();
      this.replayWal();
    });
    this.irc.on("error", (e: Error) => opts.log?.(`irc error: ${e.message}`));
    this.irc.on("saslFailed", (why: string) => {
      this.authError = why;
      opts.log?.(`SASL failed: ${why}`);
    });
  }

  get steward(): string {
    return stewardNick(this.principal);
  }

  start(): void {
    this.irc.connect();
    this.helloTimer = setInterval(() => this.hello(), 5 * 60_000);
    this.helloTimer.unref();
  }

  stop(): void {
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.irc.close();
  }

  // --- outgoing --------------------------------------------------------------------

  send(target: string, env: Envelope): void {
    // Remember direct-to-session sends briefly: if the server says the nick is gone (401),
    // they're re-routed to that principal's steward (see onNoSuchNick).
    const nick = parseNick(target);
    if (nick && nick.handle !== "steward" && !env.data?.undeliverable) {
      const now = Date.now();
      for (const [id, s] of this.directSends) if (now - s.at > 30_000) this.directSends.delete(id);
      this.directSends.set(env.id, { target: target.toLowerCase(), env, at: now });
    }
    for (const line of encodeEnvelope(target, env)) this.irc.send(line);
  }

  /** The nick we messaged has gone: hand what we sent it to its principal's steward instead. */
  private onNoSuchNick(gone: string): void {
    const nick = parseNick(gone);
    if (!nick) return;
    for (const [id, s] of this.directSends) {
      if (s.target !== gone.toLowerCase()) continue;
      this.directSends.delete(id);
      this.send(stewardNick(nick.principal), { ...s.env, data: { ...(s.env.data ?? {}), undeliverable: { to: s.target } } });
    }
  }

  /** Send and wait for the reply/ack whose `re` is this envelope's id. */
  request(target: string, env: Envelope, timeoutMs = 8_000): Promise<Received | undefined> {
    this.myRequests.add(env.id);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(env.id);
        resolve(undefined);
      }, timeoutMs);
      this.waiting.set(env.id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.send(target, env);
    });
  }

  hello(): void {
    const full: Hello = { agent: this.agent, role: this.role, focus: this.focus, cards: [...this.cards], shared: this.shared };
    // The lobby only gets details when this session is shared.
    const pub: Hello = this.shared ? full : { agent: this.agent };
    const desc = [this.agent, this.role, this.shared ? this.focus : undefined].filter(Boolean).join(" · ");
    this.send(LOBBY, { kind: "hello", id: newId(), text: desc, data: { ...pub } });
    this.helloSteward(full, 0);
  }

  /** A steward started on demand misses our first hello, so retry until it acks. */
  private helloSteward(full: Hello, attempt: number): void {
    this.request(this.steward, { kind: "hello", id: newId(), data: { ...full } }, 3_000).then((ack) => {
      if (!ack) {
        if (attempt < 10 && this.irc.isRegistered) setTimeout(() => this.helloSteward(full, attempt + 1), 1_000).unref();
        return;
      }
      this.shared = Boolean(ack.data?.shared);
      this.defaultShared = (ack.data?.defaultShared as boolean | null | undefined) ?? null;
      this.emit("steward");
    });
  }

  setFocus(focus?: string, role?: string): void {
    if (focus !== undefined) this.focus = scrub(focus).slice(0, 200);
    if (role !== undefined) this.role = role.slice(0, 60);
    this.hello();
  }

  /** Durable: goes through the WAL. Resolves with the steward's ack, or undefined if queued. */
  async checkpoint(data: Record<string, unknown>): Promise<Received | undefined> {
    const env: Envelope = { kind: "checkpoint", id: newId(), data: scrubDeep({ ...data, agent: this.agent, role: this.role }) };
    if (typeof data.card === "string") env.card = data.card;
    this.wal.append(this.steward, env);
    const ack = await this.request(this.steward, env);
    this.onAck(env.id, ack);
    return ack;
  }

  async update(text: string, card?: string, refs?: Ref[]): Promise<Received | undefined> {
    const clean = scrub(text).slice(0, MAX_TEXT);
    const env: Envelope = { kind: "update", id: newId(), card, text: clean, data: refs?.length ? { refs: scrubDeep(refs) } : undefined };
    this.wal.append(this.steward, env);
    if (this.shared) {
      // The lobby is the bus stewards watch for relevance; the card channel is where people
      // (and agents) watching that card see it. Separate ids: envelopes reassemble per id.
      this.send(LOBBY, { ...env, id: newId() });
      if (card && this.cards.has(card)) this.send(cardChannel(this.principal, card), { ...env, id: newId() });
    }
    const ack = await this.request(this.steward, env);
    this.onAck(env.id, ack);
    return ack;
  }

  private onAck(id: string, ack: Received | undefined): void {
    if (!ack) return;
    this.wal.ack(id);
    const card = ack.data?.card;
    if (typeof card === "string" && !this.cards.has(card)) {
      this.cards.add(card);
      this.irc.join(cardChannel(this.principal, card));
      this.hello();
    }
  }

  private replayWal(): void {
    for (const { target, env } of this.wal.unacked()) {
      this.request(target, env, 15_000).then((ack) => this.onAck(env.id, ack));
    }
    this.replayOrphans();
  }

  /** WALs left behind by crashed sessions of the same principal: replay on their behalf. */
  private replayOrphans(): void {
    const dir = join(troughHome(), "wal");
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    const mine = `${this.nick.replace("|", "_")}.jsonl`;
    for (const f of files) {
      if (f === mine || !f.startsWith(`${this.principal}_`) || !f.endsWith(".jsonl")) continue;
      const orphan = new Wal(join(dir, f));
      const pending = orphan.unacked();
      if (!pending.length) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          // another session got there first
        }
        continue;
      }
      const original = f.slice(0, -6).replace("_", "|");
      for (const { target, env } of pending) {
        const replay = { ...env, data: { ...(env.data ?? {}), session: original } };
        this.request(target, replay, 15_000).then((ack) => {
          if (ack) orphan.ack(env.id);
        });
      }
    }
  }

  recall(principal: string | undefined, query: { text?: string; refs?: Ref[]; card?: string; since?: string; recipes?: boolean }): Promise<Received | undefined> {
    const target = stewardNick(principal ?? this.principal);
    return this.request(target, { kind: "recall", id: newId(), text: query.text ? scrub(query.text).slice(0, MAX_TEXT) : undefined, data: scrubDeep({ ...query }) }, 10_000);
  }

  /** `to` is a principal (asks their steward) or a full session nick. */
  ask(to: string, text: string, card?: string): Promise<Received | undefined> {
    const target = to.includes("|") ? to : stewardNick(to);
    return this.request(target, { kind: "ask", id: newId(), card, text: scrub(text).slice(0, MAX_TEXT) }, 15_000);
  }

  reply(id: string, text: string): string {
    const orig = this.inbox.get(id);
    if (!orig) return `No message ${id} in this session's inbox.`;
    // Forwarded asks name the original asker; reply to them, not to the steward.
    if (isDone(orig.text)) return "That was 🐈 (nothing to add); don't reply to it.";
    const to = typeof orig.data?.asker === "string" ? orig.data.asker : orig.from;
    const re = typeof orig.data?.askId === "string" ? orig.data.askId : orig.id;
    // depth counts agent-to-agent turns in a thread; see MAX_DEPTH in delivery.ts.
    const depth = Number(orig.data?.depth ?? 0) + 1;
    this.send(to, { kind: "reply", id: newId(), re, card: orig.card, text: scrub(text).slice(0, MAX_TEXT), data: { depth } });
    return isDone(text) ? `Ended the exchange with ${to} (🐈).` : `Replied to ${to}.`;
  }

  steer(to: string, text: string): void {
    this.send(to, { kind: "steer", id: newId(), text: scrub(text).slice(0, MAX_TEXT) });
  }

  delegate(to: string, text: string, details: Record<string, unknown>): void {
    this.send(to, { kind: "delegate", id: newId(), text: scrub(text).slice(0, MAX_TEXT), data: scrubDeep(details) });
  }

  control(op: string, value?: unknown, session?: string, extra: Record<string, unknown> = {}): Promise<Received | undefined> {
    return this.request(this.steward, { kind: "control", id: newId(), data: { ...extra, op, value, session } });
  }

  // --- incoming --------------------------------------------------------------------

  private onReceived(r: Received | Plain): void {
    if (!("plain" in r) && r.re && this.waiting.has(r.re)) {
      const resolve = this.waiting.get(r.re)!;
      this.waiting.delete(r.re);
      resolve(r);
      if (r.kind === "ack" || r.kind === "reply") return;
    }
    const level = classify(r, this.irc.nick);
    if (level === "silent") return;
    const item: Item =
      "plain" in r
        ? { at: r.time, level, from: r.from, kind: "chat", text: r.text }
        : { at: r.time, level, from: r.from, kind: r.kind, id: r.id, re: r.re, card: r.card, text: r.text ?? "", data: r.data };
    if (item.id) this.inbox.set(item.id, item);
    if (level === "inject") {
      this.inject.push(item);
      // Integrations that can wake their agent (Pi's sendMessage with triggerTurn) listen
      // for this; hook-based ones (Claude Code) drain on their next hook instead.
      this.emit("inject", item);
    }
    this.drawer.push(item);
    if (this.drawer.length > DRAWER_MAX) this.drawer.splice(0, this.drawer.length - DRAWER_MAX);
  }

  /**
   * Delete this session's own channel messages from the server's history (Ergo HistServ;
   * needs history.retention.allow-individual-delete). Part of /trough unshare. Can't reach
   * what others already saw, and only covers messages sent since this session connected.
   */
  purgeChannelHistory(): number {
    const n = this.ownChannelMsgids.length;
    for (const { target, msgid } of this.ownChannelMsgids.splice(0)) this.irc.send(`PRIVMSG HistServ :DELETE ${target} ${msgid}`);
    return n;
  }

  /** Look at what's queued for the model without taking it. */
  peekInject(): readonly Item[] {
    return this.inject;
  }

  /** Take everything queued for the model's transcript. */
  drainInject(): Item[] {
    return this.inject.splice(0);
  }

  drawerItems(limit = 20): Item[] {
    return this.drawer.slice(-limit);
  }

  /** Who else is around, from the drawer's hellos (most recent per nick). */
  /** Keep `present` in step with the lobby's membership. */
  private trackPresence(command: string, from: string, params: string[]): void {
    const nick = (n: string) => n.replace(/^[~&@%+]+/, "").toLowerCase();
    if (command === "353" && params[2]?.toLowerCase() === LOBBY) {
      for (const n of (params[3] ?? "").split(" ")) if (parseNick(nick(n))) this.present.add(nick(n));
    } else if (command === "JOIN" && params[0]?.toLowerCase() === LOBBY && parseNick(nick(from))) {
      this.present.add(nick(from));
    } else if ((command === "PART" && params[0]?.toLowerCase() === LOBBY) || command === "QUIT") {
      this.present.delete(nick(from));
    }
  }

  roster(): { nick: string; agent?: string; role?: string; focus?: string; at: string }[] {
    const seen = new Map<string, { nick: string; agent?: string; role?: string; focus?: string; at: string }>();
    // Present but not yet heard from: nick only, details arrive with their next hello.
    for (const n of this.present) seen.set(n, { nick: n, at: "" });
    for (const i of this.drawer) {
      if (i.kind !== "hello" || !parseNick(i.from)) continue;
      seen.set(i.from, { nick: i.from, agent: i.data?.agent as string, role: i.data?.role as string, focus: i.data?.focus as string, at: i.at });
    }
    // Stewards are infrastructure, not peers; and gone-quiet hellos from departed sessions drop off.
    return [...seen.values()].filter((s) => s.nick !== this.irc.nick.toLowerCase() && !s.nick.endsWith("|steward") && (this.present.size === 0 || this.present.has(s.nick)));
  }
}
