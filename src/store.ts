// The steward's record for one principal: card event logs plus settings and session
// sharing state. Plain files under <dataDir>/<principal>/ so it's easy to inspect, back
// up or keep in git. The steward is the only writer (see docs/PROTOCOL.md, "The steward").
//
// Visibility is computed at read time: an event is team-visible only if the session that
// wrote it is currently shared (and, for digests, published). Unsharing a session flips
// its state and so hides everything it contributed; sharing again re-exposes it.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type CardKind, type Recipe, type Ref, type RelevanceLevel, type ReviewMode } from "./protocol.ts";

export type CardEvent = { at: string; session?: string; src?: string } & (
  | { type: "created"; kind: CardKind; title: string }
  | { type: "ref"; ref: Ref }
  | { type: "digest"; digestId: string; text: string; status: "draft" | "published"; publishAt?: string }
  | { type: "digest.published"; digestId: string }
  | { type: "digest.vetoed"; digestId: string }
  | { type: "decision"; text: string }
  | { type: "question"; text: string }
  | { type: "recipe"; recipeId: string; recipe: Recipe }
  | { type: "update"; text: string }
  | { type: "status"; status: string }
  | { type: "title"; title: string }
  | { type: "link"; rel: "parent" | "child" | "related" | "supersedes"; card: string }
  | { type: "attached"; agent: string; role?: string }
  | { type: "dismissed"; source: string }
  | { type: "retraction"; target: string }
  // A steer/ask/delegate for a session that had gone, kept for the next session on this card.
  | { type: "held"; kind: string; from: string; to: string; text: string; data?: Record<string, unknown> }
  | { type: "held.delivered"; heldSrc: string; deliveredTo: string }
);

export interface Card {
  id: string;
  owner: string;
  kind: CardKind;
  title: string;
  status: string;
  refs: Ref[];
  summary: string;
  digests: { id: string; text: string; status: string; session?: string; at: string }[];
  decisions: { text: string; at: string }[];
  questions: { text: string; at: string }[];
  recipes: (Recipe & { id: string; session?: string; at: string })[];
  updates: { text: string; session?: string; at: string }[];
  sessions: { nick: string; agent: string; role?: string; at: string }[];
  links: { rel: string; card: string }[];
  dismissed: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  /** null until onboarding has asked */
  defaultShared: boolean | null;
  review: ReviewMode;
  reviewDelayMs: number;
  relevance: RelevanceLevel;
}

export interface SessionState {
  shared: boolean;
  agent: string;
  role?: string;
  firstSeen: string;
  lastSeen: string;
}

export type Audience = "owner" | "team";

const DEFAULT_SETTINGS: Settings = { defaultShared: null, review: "auto-after", reviewDelayMs: 12 * 3600_000, relevance: "assisted" };

export class PrincipalStore {
  readonly principal: string;
  readonly dir: string;
  private cards = new Map<string, CardEvent[]>();
  private filed = new Set<string>();
  settings: Settings;
  sessions: Record<string, SessionState>;

  constructor(dataDir: string, principal: string) {
    this.principal = principal;
    this.dir = join(dataDir, principal);
    mkdirSync(join(this.dir, "cards"), { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(join(this.dir, "settings.json"), {}) };
    this.sessions = readJson(join(this.dir, "sessions.json"), {});
    for (const f of readdirSync(join(this.dir, "cards"))) {
      if (!f.endsWith(".jsonl")) continue;
      const events = readFileSync(join(this.dir, "cards", f), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as CardEvent];
          } catch {
            return [];
          }
        });
      this.cards.set(f.slice(0, -6), events);
      for (const e of events) if (e.src) this.filed.add(e.src);
    }
  }

  saveSettings(): void {
    writeFileSync(join(this.dir, "settings.json"), `${JSON.stringify(this.settings, null, 2)}\n`);
  }

  saveSessions(): void {
    writeFileSync(join(this.dir, "sessions.json"), `${JSON.stringify(this.sessions, null, 2)}\n`);
  }

  /** Register or refresh a session; new sessions take the principal's default sharing. */
  touchSession(nick: string, agent: string, role?: string): SessionState {
    const now = new Date().toISOString();
    let s = this.sessions[nick];
    if (!s) {
      s = { shared: this.settings.defaultShared ?? false, agent, role, firstSeen: now, lastSeen: now };
      this.sessions[nick] = s;
    } else {
      s.lastSeen = now;
      s.agent = agent || s.agent;
      if (role !== undefined) s.role = role;
    }
    this.saveSessions();
    return s;
  }

  isShared(session: string | undefined): boolean {
    if (!session) return true; // steward-authored bookkeeping
    return this.sessions[session]?.shared ?? false;
  }

  /** Has an envelope with this id already been filed? (WAL replay dedupe) */
  hasFiled(src: string): boolean {
    return this.filed.has(src);
  }

  cardIds(): string[] {
    return [...this.cards.keys()];
  }

  createCard(kind: CardKind, title: string, session: string | undefined, src?: string): string {
    const id = `c-${newId().slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    this.cards.set(id, []);
    this.append(id, { type: "created", kind, title, session, src, at: new Date().toISOString() });
    return id;
  }

  append(cardId: string, event: CardEvent): void {
    const events = this.cards.get(cardId);
    if (!events) throw new Error(`no such card: ${cardId}`);
    events.push(event);
    if (event.src) this.filed.add(event.src);
    appendFileSync(join(this.dir, "cards", `${cardId}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  events(cardId: string): CardEvent[] {
    return this.cards.get(cardId) ?? [];
  }

  /** Events a given audience may see. */
  visibleEvents(cardId: string, audience: Audience): CardEvent[] {
    const events = this.events(cardId);
    if (audience === "owner") return events;
    const published = new Set(events.filter((e) => e.type === "digest.published").map((e) => (e as { digestId: string }).digestId));
    const vetoed = new Set(events.filter((e) => e.type === "digest.vetoed").map((e) => (e as { digestId: string }).digestId));
    return events.filter((e) => {
      if (!this.isShared(e.session)) return false;
      if (e.type === "digest") return !vetoed.has(e.digestId) && (e.status === "published" || published.has(e.digestId));
      if (e.type === "retraction") return true;
      return true;
    });
  }

  /** Team-visible if a shared session contributed anything beyond creating it. */
  isVisibleToTeam(cardId: string): boolean {
    return this.visibleEvents(cardId, "team").some((e) => e.type !== "created" && e.type !== "retraction" && e.session !== undefined);
  }

  view(cardId: string, audience: Audience): Card | undefined {
    if (!this.cards.has(cardId)) return undefined;
    if (audience === "team" && !this.isVisibleToTeam(cardId)) return undefined;
    // The created event defines the card's identity even if its author is private.
    const all = this.events(cardId);
    const created = all.find((e) => e.type === "created") as Extract<CardEvent, { type: "created" }> | undefined;
    const card: Card = {
      id: cardId,
      owner: this.principal,
      kind: created?.kind ?? "task",
      title: created?.title ?? cardId,
      status: "active",
      refs: [],
      summary: "",
      digests: [],
      decisions: [],
      questions: [],
      recipes: [],
      updates: [],
      sessions: [],
      links: [],
      dismissed: [],
      createdAt: created?.at ?? "",
      updatedAt: created?.at ?? "",
    };
    const published = new Set(all.filter((e) => e.type === "digest.published").map((e) => (e as { digestId: string }).digestId));
    const vetoed = new Set(all.filter((e) => e.type === "digest.vetoed").map((e) => (e as { digestId: string }).digestId));
    for (const e of this.visibleEvents(cardId, audience)) {
      card.updatedAt = e.at;
      switch (e.type) {
        case "ref":
          if (!card.refs.some((r) => sameRef(r, e.ref))) card.refs.push(e.ref);
          break;
        case "digest":
          if (vetoed.has(e.digestId)) break;
          card.digests.push({ id: e.digestId, text: e.text, status: e.status === "published" || published.has(e.digestId) ? "published" : "draft", session: e.session, at: e.at });
          break;
        case "decision":
          card.decisions.push({ text: e.text, at: e.at });
          break;
        case "question":
          card.questions.push({ text: e.text, at: e.at });
          break;
        case "recipe":
          card.recipes.push({ ...e.recipe, id: e.recipeId, session: e.session, at: e.at });
          break;
        case "update":
          card.updates.push({ text: e.text, session: e.session, at: e.at });
          break;
        case "status":
          card.status = e.status;
          break;
        case "title":
          card.title = e.title;
          break;
        case "link":
          card.links.push({ rel: e.rel, card: e.card });
          break;
        case "attached":
          if (e.session) card.sessions.push({ nick: e.session, agent: e.agent, role: e.role, at: e.at });
          break;
        case "dismissed":
          card.dismissed.push(e.source);
          break;
      }
    }
    // Summary = the most recent published digests (owner also sees drafts), newest last.
    card.summary = card.digests
      .filter((d) => audience === "owner" || d.status === "published")
      .slice(-3)
      .map((d) => d.text)
      .join("\n\n");
    return card;
  }

  /** Digests waiting for auto-after publication that are now due. */
  dueDigests(now = Date.now()): { cardId: string; digestId: string }[] {
    const due: { cardId: string; digestId: string }[] = [];
    for (const [cardId, events] of this.cards) {
      const done = new Set(events.filter((e) => e.type === "digest.published" || e.type === "digest.vetoed").map((e) => (e as { digestId: string }).digestId));
      for (const e of events) {
        if (e.type === "digest" && e.status === "draft" && e.publishAt && !done.has(e.digestId) && Date.parse(e.publishAt) <= now) {
          due.push({ cardId, digestId: e.digestId });
        }
      }
    }
    return due;
  }

  findDigest(digestId: string): string | undefined {
    for (const [cardId, events] of this.cards) if (events.some((e) => e.type === "digest" && e.digestId === digestId)) return cardId;
    return undefined;
  }
}

export function sameRef(a: Ref, b: Ref): boolean {
  return normaliseRefType(a.type) === normaliseRefType(b.type) && normaliseRefValue(a) === normaliseRefValue(b);
}

export function normaliseRefType(type: string): string {
  return type.trim().toLowerCase();
}

export function normaliseRefValue(ref: Ref): string {
  let v = ref.value.trim().toLowerCase();
  if (normaliseRefType(ref.type) === "pr") v = v.replace(/^https?:\/\/github\.com\//, "").replace(/\/pull\//, "#");
  return v.replace(/\/+$/, "");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
