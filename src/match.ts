// Ref and keyword matching: how a session's context finds its card without anyone typing
// an id, and tiers 1-2 of proactive relevance. Deterministic, zero tokens.

import { KIND_KEY, type Ref } from "./protocol.ts";
import { normaliseRefType, normaliseRefValue, type Card } from "./store.ts";

const STOP = new Set("the and for with that this from into have has was were are not but you your our can will just about what when where how why who which there their them then than also only very more most some any all its it's on in at to of a an is be by or as".split(" "));

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** Ticket ids hidden in branch names, e.g. "tooling/TR-16855-k3s" -> TR-16855. */
export function ticketsIn(text: string): string[] {
  return [...new Set((text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{2,}\b/gi) ?? []).map((t) => t.toUpperCase()))];
}

/** Add implied refs: tickets found in branches. */
export function expandRefs(refs: Ref[]): Ref[] {
  const out = [...refs];
  for (const r of refs) {
    if (normaliseRefType(r.type) !== "branch") continue;
    for (const t of ticketsIn(r.value)) if (!out.some((o) => normaliseRefType(o.type) === "ticket" && normaliseRefValue(o) === t.toLowerCase())) out.push({ type: "ticket", value: t });
  }
  return out;
}

const WEIGHT: Record<string, number> = { ticket: 20, pr: 20, branch: 20, checkout: 15, component: 8, site: 5, host: 5, ip: 5, dashboard: 3, logs: 3, repo: 2 };

export interface Query {
  refs?: Ref[];
  text?: string;
}

export interface Scored {
  card: Card;
  score: number;
  why: string[];
}

export function scoreCard(card: Card, query: Query): Scored {
  let score = 0;
  const why: string[] = [];
  const qrefs = expandRefs(query.refs ?? []);
  const crefs = expandRefs(card.refs);
  const key = KIND_KEY[card.kind];
  for (const q of qrefs) {
    const t = normaliseRefType(q.type);
    const v = normaliseRefValue(q);
    if (!crefs.some((c) => normaliseRefType(c.type) === t && normaliseRefValue(c) === v)) continue;
    const w = t === key ? 100 : (WEIGHT[t] ?? 2);
    score += w;
    why.push(`${t}:${q.value}`);
  }
  if (query.text) {
    const q = tokens(query.text);
    const hay = tokens([card.title, card.summary, ...card.questions.map((x) => x.text), ...card.decisions.map((x) => x.text), ...card.recipes.map((r) => `${r.purpose} ${r.command}`)].join(" "));
    let overlap = 0;
    for (const w of q) if (hay.has(w)) overlap++;
    if (overlap) {
      score += Math.min(overlap * 3, 30);
      why.push(`${overlap} shared words`);
    }
  }
  return { card, score, why };
}

export function rank(cards: Card[], query: Query): Scored[] {
  return cards
    .map((c) => scoreCard(c, query))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.card.updatedAt.localeCompare(a.card.updatedAt));
}

/**
 * The steward's filing decision: a confident single match, or ambiguity (two cards
 * about as good), or nothing. Only ambiguity is worth interrupting a human for.
 */
export function decide(ranked: Scored[]): { match?: Scored; ambiguous: Scored[] } {
  const [best, second] = ranked;
  if (!best || best.score < 15) return { ambiguous: [] };
  if (second && second.score * 1.5 > best.score) return { ambiguous: ranked.slice(0, 3) };
  return { match: best, ambiguous: [] };
}
