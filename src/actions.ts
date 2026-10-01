// Shared trough tool actions for MCP clients and in-process integrations such as Pi.
import type { Received, Ref } from "./protocol.ts";
import type { Session } from "./session.ts";

export const ACTIONS = ["status", "focus", "checkpoint", "update", "recall", "catchup", "ask", "reply", "steer", "delegate", "inbox", "dismiss"] as const;

export interface Args {
  action: (typeof ACTIONS)[number];
  text?: string;
  principal?: string;
  to?: string;
  id?: string;
  card?: string;
  since?: string;
  role?: string;
  title?: string;
  kind?: string;
  status?: string;
  digest?: string;
  decisions?: string[];
  questions?: string[];
  refs?: Ref[];
  recipes?: unknown[];
  source?: string;
  target?: string;
  scope?: string;
  user_authorization?: string;
  acceptance_checks?: string;
  expected_artifact?: string;
}

interface CardLike {
  id?: string;
  card?: string;
  owner?: string;
  title?: string;
  kind?: string;
  status?: string;
  live?: string[];
  refs?: { type: string; value: string; note?: string }[];
  summary?: string;
  latest?: string;
  decisions?: ({ text: string } | string)[];
  questions?: { text: string }[];
  recipes?: ({ command: string; purpose: string; gotchas?: string; output?: string } | string)[];
  updates?: { text: string }[];
}

function renderCard(c: CardLike): string {
  const text = (x: { text: string } | string) => (typeof x === "string" ? x : x.text);
  const lines = [`## ${c.id ?? c.card} · ${c.title} [${c.kind ?? "task"}, ${c.status ?? "active"}]${c.owner ? ` · ${c.owner}` : ""}${c.live?.length ? ` · live: ${c.live.join(", ")}` : ""}`];
  if (c.refs?.length) lines.push(`refs: ${c.refs.map((r) => `${r.type}:${r.value}`).join(", ")}`);
  const summary = c.summary ?? c.latest;
  if (summary) lines.push(summary.length > 1200 ? `${summary.slice(0, 1200)}...` : summary);
  if (c.decisions?.length) lines.push(`decisions:\n${c.decisions.slice(-5).map((d) => `- ${text(d)}`).join("\n")}`);
  if (c.questions?.length) lines.push(`open questions:\n${c.questions.slice(-5).map((q) => `- ${q.text}`).join("\n")}`);
  if (c.recipes?.length) {
    lines.push(`recipes:\n${c.recipes.slice(-8).map((r) => (typeof r === "string" ? `- ${r}` : `- \`${r.command}\` - ${r.purpose}${r.gotchas ? ` (gotcha: ${r.gotchas})` : ""}${r.output ? `\n  output: ${r.output.slice(0, 300)}` : ""}`)).join("\n")}`);
  }
  if (c.updates?.length) lines.push(`latest update: ${c.updates.at(-1)!.text}`);
  return lines.join("\n");
}

function format(r: Received | undefined, fallback: string): string {
  if (!r) return fallback;
  const cards = r.data?.cards;
  if (Array.isArray(cards)) return [r.text ?? "", ...cards.map((c) => renderCard(c as CardLike))].filter(Boolean).join("\n\n");
  const parts = [r.text ?? ""];
  if (r.data && Object.keys(r.data).length) parts.push(JSON.stringify(r.data));
  return parts.filter(Boolean).join("\n");
}

/** Run the common, non-sharing action set. Share/unshare remain human-only commands. */
export async function runAction(s: Session, a: Args): Promise<string> {
  switch (a.action) {
    case "status": {
      const roster = s.roster().map((r) => `- ${r.nick} (${[r.agent, r.role].filter(Boolean).join(", ")})${r.focus ? `: ${r.focus}` : ""}`);
      const recent = s.drawerItems(8).map((i) => `- ${i.from} ${i.kind}: ${i.text.slice(0, 160)}`);
      const onboarding =
        s.authError ? `\nThe IRC server rejected this account (${s.authError}); the human should run \`trough init\`.`
        : s.defaultShared === undefined ? "\nYour steward hasn't answered yet (it may be starting)."
        : s.defaultShared === null ? "\nYour human hasn't chosen a sharing default yet; suggest they run \`/trough default-shared yes|no\`."
        : "";
      return [`You are ${s.nick}, ${s.shared ? "shared with the team" : "private"}; cards: ${[...s.cards].join(", ") || "none yet"}.${onboarding}`, roster.length ? `Around:\n${roster.join("\n")}` : "Nobody else seen yet.", recent.length ? `Recent:\n${recent.join("\n")}` : ""].filter(Boolean).join("\n");
    }
    case "focus":
      s.setFocus(a.text, a.role);
      return "Focus updated.";
    case "checkpoint": {
      const ack = await s.checkpoint({ card: a.card, title: a.title, kind: a.kind, status: a.status, digest: a.digest ?? a.text, decisions: a.decisions, questions: a.questions, refs: a.refs, recipes: a.recipes });
      if (!ack) return "Queued in the local WAL; your steward will file it when reachable.";
      if (ack.data?.filed === false) return format(ack, "Ambiguous; resend with card=<id>.");
      return `Filed on ${ack.data?.card}${ack.data?.created ? " (new card)" : ""}: ${ack.data?.title ?? ""}`;
    }
    case "update": {
      if (!a.text) return "update needs text.";
      const ack = await s.update(a.text, a.card, a.refs);
      return ack ? `Filed on ${ack.data?.card}.` : "Queued in the local WAL.";
    }
    case "recall":
      return format(await s.recall(a.principal, { text: a.text, refs: a.refs, card: a.card }), `No answer from ${a.principal ?? s.principal}|steward.`);
    case "catchup":
      return format(await s.recall(a.principal, { since: a.since ?? "1d" }), `No answer from ${a.principal ?? s.principal}|steward.`);
    case "ask":
      if (!a.to || !a.text) return "ask needs to and text.";
      return format(await s.ask(a.to, a.text, a.card), `Sent to ${a.to}; no reply yet. Replies will show up in later tool results.`);
    case "reply":
      if (!a.id || !a.text) return "reply needs id and text.";
      return s.reply(a.id, a.text);
    case "steer":
      if (!a.to || !a.text) return "steer needs to and text.";
      s.steer(a.to, a.text);
      return `Steered ${a.to}.`;
    case "delegate":
      if (!a.to || !a.text) return "delegate needs to and text.";
      s.delegate(a.to, a.text, { target: a.target, scope: a.scope, userAuthorization: a.user_authorization, acceptanceChecks: a.acceptance_checks, expectedArtifact: a.expected_artifact });
      return `Delegated to ${a.to}.`;
    case "inbox": {
      const items = s.drawerItems(30).filter((i) => i.level === "inject");
      return items.length ? items.map((i) => `- [${i.id}] ${i.kind} from ${i.from}: ${i.text}`).join("\n") : "Nothing addressed to you.";
    }
    case "dismiss":
      if (!a.card || !a.source) return "dismiss needs card and source.";
      return format(await s.control("dismiss", undefined, undefined, { card: a.card, source: a.source }), "Dismissed.");
  }
}
