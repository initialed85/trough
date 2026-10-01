// The steward: one per principal, sole writer of that principal's cards.
// Pure protocol logic over a Transport so it's testable without IRC; steward-main.ts
// wires it to a real connection. See docs/PROTOCOL.md "The steward" and "Key flows".

import { decide, expandRefs, rank, tokens, type Query } from "./match.ts";
import { judgeRelevance, complete, type LlmConfig } from "./llm.ts";
import {
  CARD_KINDS,
  STEWARDS_CHANNEL,
  isAuthentic,
  parseDuration,
  newId,
  parseNick,
  stewardNick,
  type CardKind,
  type Envelope,
  type Recipe,
  type Received,
  type Ref,
} from "./protocol.ts";
import { sameRef, type Card, type PrincipalStore } from "./store.ts";

export interface Transport {
  send(target: string, env: Envelope): void;
}

interface Live {
  agent: string;
  role?: string;
  focus?: string;
  cards: Set<string>;
  lastSeen: number;
}

const LIVE_TTL_MS = 30 * 60_000;
const NOTES_PER_HOUR = 4;

export class Steward {
  readonly principal: string;
  readonly nick: string;
  readonly store: PrincipalStore;
  private transport: Transport;
  private llm?: LlmConfig;
  private live = new Map<string, Live>();
  /** card -> source envelope ids already raised (relevance dedupe) */
  private raised = new Map<string, Set<string>>();
  /** session -> timestamps of notes sent (rate limit) */
  private noteTimes = new Map<string, number[]>();
  /** source session -> card ids we raised notes about (so a retract can drop them) */
  private raisedFrom = new Map<string, Set<string>>();

  constructor(store: PrincipalStore, transport: Transport, llm?: LlmConfig) {
    this.store = store;
    this.principal = store.principal;
    this.nick = stewardNick(store.principal);
    this.transport = transport;
    this.llm = llm;
  }

  // --- entry points ---------------------------------------------------------------

  async handle(msg: Received): Promise<void> {
    if (!isAuthentic(msg.from, msg.account)) return; // unauthenticated: humans' chatter, no protocol trust
    const from = parseNick(msg.from)!;
    const mine = from.principal === this.principal;
    const toMe = msg.target.toLowerCase() === this.nick;

    if (msg.target === STEWARDS_CHANNEL) {
      if (msg.kind === "retract") this.onRetract(msg);
      return;
    }
    if (mine && from.handle !== "steward") {
      switch (msg.kind) {
        case "hello":
          return this.onHello(msg, toMe);
        case "checkpoint":
          if (toMe) return this.onCheckpoint(msg);
          return;
        case "update":
          if (toMe) return this.onUpdate(msg);
          return;
        case "control":
          if (toMe) return this.onControl(msg);
          return;
      }
    }
    if (toMe && msg.data?.undeliverable && (msg.kind === "steer" || msg.kind === "ask" || msg.kind === "delegate")) return this.onUndeliverable(msg, mine);
    if (toMe && msg.kind === "recall") return this.onRecall(msg, mine ? "owner" : "team");
    if (toMe && msg.kind === "ask") return this.onAsk(msg, mine);
    if (!mine && (msg.kind === "update" || msg.kind === "hello") && !toMe) return this.onForeignActivity(msg);
  }

  /** IRC QUIT/PART of a session. */
  onGone(nick: string): void {
    this.live.delete(nick.toLowerCase());
  }

  /** Called every minute or so: publish due digests, expire stale live sessions. */
  tick(now = Date.now()): void {
    for (const { cardId, digestId } of this.store.dueDigests(now)) {
      this.store.append(cardId, { type: "digest.published", digestId, at: new Date(now).toISOString() });
    }
    for (const [nick, l] of this.live) if (now - l.lastSeen > LIVE_TTL_MS) this.live.delete(nick);
  }

  liveSessions(): Map<string, Live> {
    return this.live;
  }

  // --- own sessions -----------------------------------------------------------------

  private touchLive(nick: string, patch: Partial<Live>): Live {
    const key = nick.toLowerCase();
    const l = this.live.get(key) ?? { agent: "unknown", cards: new Set<string>(), lastSeen: Date.now() };
    Object.assign(l, patch, { lastSeen: Date.now() });
    this.live.set(key, l);
    return l;
  }

  private onHello(msg: Received, toMe: boolean): void {
    const d = msg.data ?? {};
    const agent = str(d.agent) ?? "unknown";
    const known = Boolean(this.store.sessions[msg.from.toLowerCase()]);
    const state = this.store.touchSession(msg.from.toLowerCase(), agent, str(d.role));
    const l = this.touchLive(msg.from, { agent, role: str(d.role), focus: str(d.focus) });
    for (const c of arr<string>(d.cards)) if (this.store.events(c).length) l.cards.add(c);
    if (toMe || !known) {
      this.transport.send(msg.from, {
        kind: "ack",
        id: newId(),
        re: msg.id,
        data: { shared: state.shared, defaultShared: this.store.settings.defaultShared, onboarding: this.store.settings.defaultShared === null },
      });
    }
  }

  /** Find or create the card a checkpoint/update belongs to. */
  private resolveCard(msg: Received, query: Query, kindHint?: string, titleHint?: string): { card?: string; created?: boolean; ambiguous?: Card[] } {
    const explicit = msg.card ?? str(msg.data?.card);
    if (explicit && this.store.events(explicit).length) return { card: explicit };
    const views = this.store.cardIds().map((id) => this.store.view(id, "owner")!).filter((c) => c.status !== "done" || c.kind === "component");
    const kind = (CARD_KINDS as readonly string[]).includes(kindHint ?? "") ? (kindHint as CardKind) : undefined;
    const ranked = rank(kind ? views.filter((v) => v.kind === kind) : views, query);
    const { match, ambiguous } = decide(ranked);
    if (match) return { card: match.card.id };
    if (ambiguous.length) return { ambiguous: ambiguous.map((a) => a.card) };
    const title = titleHint || firstLine(query.text) || "Untitled work";
    return { card: this.store.createCard(kind ?? "task", title.slice(0, 120), this.sessionOf(msg), undefined), created: true };
  }

  private onCheckpoint(msg: Received): void {
    if (this.store.hasFiled(msg.id)) return this.ackFiled(msg, { duplicate: true });
    const d = msg.data ?? {};
    const refs = expandRefs(arr<Ref>(d.refs).filter(isRef));
    const text = str(d.digest) ?? msg.text ?? "";
    const resolved = this.resolveCard(msg, { refs, text: `${str(d.title) ?? ""} ${text}` }, str(d.kind), str(d.title));
    if (resolved.ambiguous) {
      return this.transport.send(msg.from, {
        kind: "ack",
        id: newId(),
        re: msg.id,
        text: "Two or more cards match about equally; resend with an explicit card.",
        data: { filed: false, ambiguous: resolved.ambiguous.map(brief) },
      });
    }
    const card = resolved.card!;
    const at = new Date().toISOString();
    const session = this.sessionOf(msg);
    const src = msg.id;
    const live = this.touchLive(session, {});
    live.cards.add(card);
    const view = this.store.view(card, "owner")!;
    if (!view.sessions.some((s) => s.nick === session)) {
      const st = this.store.sessions[session];
      this.store.append(card, { type: "attached", agent: st?.agent ?? live.agent, role: st?.role, session, at });
      this.deliverHeld(card, session);
    }
    for (const ref of refs) if (!view.refs.some((r) => sameRef(r, ref))) this.store.append(card, { type: "ref", ref, session, at });
    if (str(d.title) && !resolved.created && str(d.title) !== view.title) this.store.append(card, { type: "title", title: str(d.title)!, session, at });
    if (str(d.status)) this.store.append(card, { type: "status", status: str(d.status)!, session, at });
    for (const t of arr<string>(d.decisions)) if (typeof t === "string") this.store.append(card, { type: "decision", text: t, session, at });
    for (const t of arr<string>(d.questions)) if (typeof t === "string") this.store.append(card, { type: "question", text: t, session, at });
    for (const r of arr<Recipe>(d.recipes)) if (r && typeof r.command === "string") this.store.append(card, { type: "recipe", recipeId: newId(), recipe: r, session, at });
    for (const l of arr<{ rel: string; card: string }>(d.links)) {
      if (l && typeof l.card === "string" && ["parent", "child", "related", "supersedes"].includes(l.rel)) this.store.append(card, { type: "link", rel: l.rel as "parent", card: l.card, session, at });
    }
    if (text) {
      const mode = this.store.settings.review;
      const digestId = newId();
      this.store.append(card, {
        type: "digest",
        digestId,
        text,
        status: mode === "auto" ? "published" : "draft",
        publishAt: mode === "auto-after" ? new Date(Date.now() + this.store.settings.reviewDelayMs).toISOString() : undefined,
        session,
        src,
        at,
      });
    } else {
      // Mark the envelope filed even when there's no digest text.
      this.store.append(card, { type: "status", status: view.status, session, src, at });
    }
    this.ackFiled(msg, { card, created: Boolean(resolved.created), title: this.store.view(card, "owner")!.title });
  }

  private onUpdate(msg: Received): void {
    if (this.store.hasFiled(msg.id)) return this.ackFiled(msg, { duplicate: true });
    const text = msg.text ?? str(msg.data?.text) ?? "";
    const refs = expandRefs(arr<Ref>(msg.data?.refs).filter(isRef));
    const resolved = this.resolveCard(msg, { refs, text });
    if (!resolved.card) return this.ackFiled(msg, { filed: false, ambiguous: (resolved.ambiguous ?? []).map(brief) });
    this.store.append(resolved.card, { type: "update", text, session: this.sessionOf(msg), src: msg.id, at: new Date().toISOString() });
    this.touchLive(msg.from, {}).cards.add(resolved.card);
    this.ackFiled(msg, { card: resolved.card });
  }

  /** The session an envelope speaks for: itself, or a crashed sibling whose WAL it's replaying. */
  private sessionOf(msg: Received): string {
    const claimed = str(msg.data?.session)?.toLowerCase();
    if (claimed && parseNick(claimed)?.principal === this.principal) return claimed;
    return msg.from.toLowerCase();
  }

  private ackFiled(msg: Received, data: Record<string, unknown>): void {
    this.transport.send(msg.from, { kind: "ack", id: newId(), re: msg.id, data: { filed: true, ...data } });
  }

  private onControl(msg: Received): void {
    const d = msg.data ?? {};
    const op = str(d.op);
    // The CLI controls a session by naming it; a session controls itself.
    const session = (str(d.session) ?? msg.from).toLowerCase();
    const reply = (text: string, data: Record<string, unknown> = {}) => this.transport.send(msg.from, { kind: "ack", id: newId(), re: msg.id, text, data: { op, ...data } });
    const s = this.store.sessions[session];
    switch (op) {
      case "default-shared": {
        this.store.settings.defaultShared = Boolean(d.value);
        this.store.saveSettings();
        return reply(`New sessions will start ${d.value ? "shared" : "private"}. Existing sessions keep their state.`, { defaultShared: this.store.settings.defaultShared });
      }
      case "share": {
        if (!s) return reply(`No session ${session} known to ${this.nick}.`);
        if (s.shared) return reply(`${session} is already shared.`, { shared: true, changed: false });
        s.shared = true;
        this.store.saveSessions();
        return reply(`${session} is now shared; its existing digests are visible (subject to owner review).`, { shared: true, changed: true });
      }
      case "unshare": {
        if (!s) return reply(`No session ${session} known to ${this.nick}.`);
        if (!s.shared) return reply(`${session} is already private.`, { shared: false, changed: false });
        s.shared = false;
        this.store.saveSessions();
        const cards = this.store.cardIds().filter((id) => this.store.events(id).some((e) => e.session === session));
        const at = new Date().toISOString();
        for (const c of cards) this.store.append(c, { type: "retraction", target: session, at });
        this.transport.send(STEWARDS_CHANNEL, { kind: "retract", id: newId(), data: { principal: this.principal, session, cards } });
        return reply(`${session} is now private. Retracted it from ${cards.length} card(s) and told other stewards to drop it.`, { shared: false, changed: true, cards });
      }
      case "sharing":
        return reply(`Default: ${fmtDefault(this.store.settings.defaultShared)}. ${session}: ${s ? (s.shared ? "shared" : "private") : "unknown"}.`, { defaultShared: this.store.settings.defaultShared, shared: s?.shared });
      case "review": {
        const mode = str(d.value);
        if (mode === "review" || mode === "auto-after" || mode === "auto") {
          this.store.settings.review = mode;
          this.store.saveSettings();
        }
        return reply(`Review mode: ${this.store.settings.review}.`);
      }
      case "relevance": {
        const level = str(d.value);
        if (level === "off" || level === "refs" || level === "assisted") {
          this.store.settings.relevance = level;
          this.store.saveSettings();
        }
        return reply(`Relevance: ${this.store.settings.relevance}.`);
      }
      case "approve":
      case "veto": {
        const digestId = str(d.value) ?? "";
        const card = this.store.findDigest(digestId);
        if (!card) return reply(`No digest ${digestId}.`);
        this.store.append(card, { type: op === "approve" ? "digest.published" : "digest.vetoed", digestId, at: new Date().toISOString() });
        return reply(`Digest ${digestId} ${op === "approve" ? "published" : "vetoed"}.`);
      }
      case "drafts": {
        const drafts = this.store.cardIds().flatMap((id) => this.store.view(id, "owner")!.digests.filter((g) => g.status === "draft").map((g) => ({ card: id, ...g })));
        return reply(`${drafts.length} draft digest(s).`, { drafts });
      }
      case "dismiss": {
        const card = str(d.card);
        const source = str(d.source);
        if (card && source && this.store.events(card).length) this.store.append(card, { type: "dismissed", source, session, at: new Date().toISOString() });
        return reply("Dismissed.");
      }
      default:
        return reply(`Unknown control op: ${op}`);
    }
  }

  // --- messages for sessions that have gone ----------------------------------------

  /**
   * A steer/ask/delegate whose target session had gone (the sender's client got 401 and
   * re-routed it here). Sessions are short-lived but their cards aren't, so treat it as a
   * message about that session's work: pass it to a live session on the same card, else
   * hold it on the card for the next one (answering an ask from the card meanwhile), else
   * say plainly that it couldn't be delivered.
   */
  private async onUndeliverable(msg: Received, mine: boolean): Promise<void> {
    const gone = str((msg.data?.undeliverable as { to?: string } | undefined)?.to)?.toLowerCase() ?? "";
    if (parseNick(gone)?.principal !== this.principal) return;
    const text = msg.text ?? "";
    const reply = (t: string, data: Record<string, unknown> = {}) => this.transport.send(msg.from, { kind: "reply", id: newId(), re: msg.id, text: t, data: { undeliverable: gone, ...data } });
    const cards = this.store
      .cardIds()
      .filter((id) => this.store.events(id).some((e) => e.session === gone))
      .sort((a, b) => (this.store.events(b).at(-1)?.at ?? "").localeCompare(this.store.events(a).at(-1)?.at ?? ""));
    if (!cards.length) return reply(`${gone} has gone and left no cards, so this wasn't delivered.`);
    if (!mine && !cards.some((c) => this.store.isVisibleToTeam(c))) return reply(`${gone} has gone; nothing it worked on is shared, so this wasn't delivered.`);
    const successor = [...this.live.entries()].find(([n, l]) => n !== gone && cards.some((c) => l.cards.has(c)) && (mine || this.store.isShared(n)));
    const { undeliverable: _drop, ...rest } = msg.data ?? {};
    if (successor) {
      const [to, l] = successor;
      const card = cards.find((c) => l.cards.has(c))!;
      this.transport.send(to, { kind: msg.kind, id: newId(), card, text: `(from ${msg.from}, originally for ${gone}) ${text}`, data: { ...rest, asker: msg.from, askId: msg.id, via: this.nick, originalTo: gone } });
      return reply(`${gone} has gone; passed to ${to}, which is on the same work (${card}).`, { forwarded: to, card });
    }
    const card = cards[0]!;
    if (!this.store.hasFiled(msg.id)) this.store.append(card, { type: "held", kind: msg.kind, from: msg.from, to: gone, text, data: rest, src: msg.id, at: new Date().toISOString() });
    const view = this.store.view(card, mine ? "owner" : "team") ?? this.store.view(card, "owner")!;
    const answer = msg.kind === "ask" ? ` From the card meanwhile: ${cardAnswer(view)}` : "";
    reply(`${gone} has gone and nobody is on "${view.title}" (${card}) right now; held there for the next session that picks it up.${answer}`, { held: card });
  }

  /** Hand held messages on a card to a session that has just attached to it. */
  private deliverHeld(card: string, session: string): void {
    const events = this.store.events(card);
    const done = new Set(events.filter((e) => e.type === "held.delivered").map((e) => (e as { heldSrc: string }).heldSrc));
    for (const e of events) {
      if (e.type !== "held" || !e.src || done.has(e.src)) continue;
      this.transport.send(session, { kind: e.kind as "steer", id: newId(), card, text: `(held for you: from ${e.from}, originally for ${e.to}) ${e.text}`, data: { ...(e.data ?? {}), asker: e.from, askId: e.src, via: this.nick, originalTo: e.to } });
      this.store.append(card, { type: "held.delivered", heldSrc: e.src, deliveredTo: session, at: new Date().toISOString() });
    }
  }

  // --- recall, catchup, ask ---------------------------------------------------------

  private visibleCards(audience: "owner" | "team"): Card[] {
    return this.store.cardIds().flatMap((id) => {
      const v = this.store.view(id, audience);
      return v ? [v] : [];
    });
  }

  private onRecall(msg: Received, audience: "owner" | "team"): void {
    const d = msg.data ?? {};
    const since = str(d.since);
    if (since) return this.onCatchup(msg, audience, since);
    const cardId = str(d.card);
    if (cardId) {
      const v = this.store.view(cardId, audience);
      return this.transport.send(msg.from, { kind: "reply", id: newId(), re: msg.id, text: v ? `${v.title} [${v.status}]` : `No card ${cardId} visible to you.`, data: { cards: v ? [this.withLive(v)] : [] } });
    }
    const query: Query = { refs: arr<Ref>(d.refs).filter(isRef), text: str(d.text) ?? msg.text };
    const ranked = rank(this.visibleCards(audience), query).slice(0, 3);
    const none = audience === "team" ? `Not in anything ${this.principal} has shared.` : "No matching card.";
    this.transport.send(msg.from, {
      kind: "reply",
      id: newId(),
      re: msg.id,
      text: ranked.length ? ranked.map((r) => `${r.card.id}: ${r.card.title}`).join("; ") : none,
      data: { cards: ranked.map((r) => ({ ...this.withLive(r.card), score: r.score, why: r.why })), principal: this.principal },
    });
  }

  private onCatchup(msg: Received, audience: "owner" | "team", since: string): void {
    const cutoff = Date.now() - parseDuration(since);
    const groups = this.store
      .cardIds()
      .flatMap((id) => {
        const v = this.store.view(id, audience);
        if (!v) return [];
        const recent = this.store.visibleEvents(id, audience).filter((e) => Date.parse(e.at) >= cutoff && e.type !== "attached" && e.type !== "retraction");
        if (!recent.length) return [];
        const live = [...this.live.entries()].filter(([, l]) => l.cards.has(id)).map(([n]) => n);
        return [
          {
            card: id,
            title: v.title,
            kind: v.kind,
            status: v.status,
            events: recent.length,
            decisions: recent.filter((e) => e.type === "decision").map((e) => (e as { text: string }).text),
            recipes: recent.filter((e) => e.type === "recipe").map((e) => (e as { recipe: Recipe }).recipe.purpose),
            latest: v.summary.slice(0, 400),
            live,
          },
        ];
      })
      .sort((a, b) => b.events - a.events);
    const text = groups.length ? `${this.principal}, last ${since}: ${groups.map((g) => `${g.title} [${g.status}]${g.live.length ? " (live)" : ""}`).join("; ")}` : `Nothing shared by ${this.principal} in the last ${since}.`;
    this.transport.send(msg.from, { kind: "reply", id: newId(), re: msg.id, text, data: { principal: this.principal, since, cards: groups } });
  }

  private async onAsk(msg: Received, mine: boolean): Promise<void> {
    const audience = mine ? "owner" : "team";
    const question = msg.text ?? str(msg.data?.text) ?? "";
    const ranked = rank(this.visibleCards(audience), { text: question, refs: arr<Ref>(msg.data?.refs).filter(isRef) });
    const best = ranked[0];
    const liveOnBest = best ? [...this.live.entries()].filter(([n, l]) => l.cards.has(best.card.id) && this.store.isShared(n)).map(([n]) => n) : [];
    if (best && liveOnBest.length && !msg.data?.noForward) {
      // A live session on the card answers better than the record does.
      const to = liveOnBest[0]!;
      this.transport.send(to, { kind: "ask", id: newId(), card: best.card.id, text: question, data: { asker: msg.from, askId: msg.id, via: this.nick } });
      return this.transport.send(msg.from, { kind: "reply", id: newId(), re: msg.id, text: `Passed to ${to}, who is on "${best.card.title}" right now; they'll reply to you directly.`, data: { forwarded: to, card: best.card.id } });
    }
    if (!best) {
      const anyLive = [...this.live.keys()].filter((n) => this.store.isShared(n));
      return this.transport.send(msg.from, {
        kind: "reply",
        id: newId(),
        re: msg.id,
        text: `Not in anything ${this.principal} has shared.${anyLive.length ? ` Live sessions you could ask: ${anyLive.join(", ")}.` : ""}`,
        data: { cards: [], live: anyLive },
      });
    }
    let answer = cardAnswer(best.card);
    if (this.llm) {
      const composed = await complete(
        this.llm,
        `You answer questions on behalf of ${this.principal}, using only the card below (their shared work record). Be brief and specific. If the card doesn't answer it, say so; never guess.`,
        `Card:\n${JSON.stringify(best.card).slice(0, 12_000)}\n\nQuestion from ${msg.from}: ${question}`,
      );
      if (composed) answer = composed;
    }
    this.transport.send(msg.from, { kind: "reply", id: newId(), re: msg.id, card: best.card.id, text: answer, data: { cards: [this.withLive(best.card)] } });
  }

  private withLive(card: Card): Card & { live: string[] } {
    const live = [...this.live.entries()].filter(([n, l]) => l.cards.has(card.id) && this.store.isShared(n)).map(([n]) => n);
    return { ...card, live };
  }

  // --- proactive relevance ----------------------------------------------------------

  private async onForeignActivity(msg: Received): Promise<void> {
    const level = this.store.settings.relevance;
    if (level === "off") return;
    const d = msg.data ?? {};
    const refs = expandRefs(arr<Ref>(d.refs).filter(isRef));
    const text = [msg.text, str(d.focus), str(d.text)].filter(Boolean).join(" ");
    if (!refs.length && !text) return;
    for (const [nick, live] of this.live) {
      for (const cardId of live.cards) {
        const card = this.store.view(cardId, "owner");
        if (!card || card.status === "done") continue;
        const seen = this.raised.get(cardId) ?? new Set<string>();
        if (seen.has(msg.id) || card.dismissed.includes(msg.from.toLowerCase())) continue;
        // Tier 1: shared refs. Tier 2: shared words with summary or open questions.
        const refHits = refs.filter((r) => card.refs.some((c) => sameRef(c, r)));
        const words = [...tokens(text)].filter((w) => tokens(`${card.title} ${card.summary} ${card.questions.map((q) => q.text).join(" ")}`).has(w));
        const strong = refHits.length > 0;
        const weak = !strong && level === "assisted" && words.length >= 3;
        if (!strong && !weak) continue;
        let why = strong ? `shares ${refHits.map((r) => `${r.type}:${r.value}`).join(", ")}` : `${words.length} shared words`;
        if (this.llm && level === "assisted") {
          const verdict = await judgeRelevance(this.llm, `${card.title}\n${card.summary}\nOpen questions: ${card.questions.map((q) => q.text).join("; ")}`, `${msg.from}: ${text}`);
          if (!verdict.relevant) continue;
          why = verdict.why || why;
        } else if (!strong) {
          continue; // without a model, keyword-only matches stay in the drawer
        }
        if (!this.allowNote(nick)) continue;
        seen.add(msg.id);
        this.raised.set(cardId, seen);
        const from = msg.from.toLowerCase();
        const raisedFor = this.raisedFrom.get(from) ?? new Set<string>();
        raisedFor.add(cardId);
        this.raisedFrom.set(from, raisedFor);
        this.transport.send(nick, { kind: "note", id: newId(), card: cardId, text: `${msg.from} (${why}): ${text.slice(0, 300)}`, data: { source: from, sourceId: msg.id, refs: refHits, why } });
      }
    }
  }

  private allowNote(session: string): boolean {
    const now = Date.now();
    const times = (this.noteTimes.get(session) ?? []).filter((t) => now - t < 3600_000);
    if (times.length >= NOTES_PER_HOUR) return false;
    times.push(now);
    this.noteTimes.set(session, times);
    return true;
  }

  private onRetract(msg: Received): void {
    const session = str(msg.data?.session)?.toLowerCase();
    if (!session) return;
    // Stewards never copy other principals' cards, so the only thing to drop is our
    // relevance bookkeeping about the retracted session.
    this.raisedFrom.delete(session);
  }
}

// --- helpers ------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function isRef(r: unknown): r is Ref {
  return Boolean(r && typeof (r as Ref).type === "string" && typeof (r as Ref).value === "string");
}

function firstLine(text?: string): string | undefined {
  return text?.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120);
}

function brief(c: Card): { id: string; title: string; kind: string; status: string } {
  return { id: c.id, title: c.title, kind: c.kind, status: c.status };
}

function fmtDefault(v: boolean | null): string {
  return v === null ? "not chosen yet" : v ? "shared" : "private";
}


function cardAnswer(card: Card): string {
  const parts = [`${card.title} [${card.status}]`];
  if (card.summary) parts.push(card.summary.slice(0, 280));
  if (card.decisions.length) parts.push(`Decided: ${card.decisions.slice(-2).map((d) => d.text).join("; ")}`);
  if (card.questions.length) parts.push(`Open: ${card.questions.slice(-2).map((q) => q.text).join("; ")}`);
  if (card.recipes.length) parts.push(`${card.recipes.length} recipe(s) on ${card.id}`);
  return parts.join(" - ");
}
