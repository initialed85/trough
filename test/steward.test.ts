// Steward behaviour through a fake transport: the flows in docs/PROTOCOL.md "Key flows".
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STEWARDS_CHANNEL, type Envelope, type Received } from "../src/protocol.ts";
import { Steward } from "../src/steward.ts";
import { PrincipalStore } from "../src/store.ts";

function setup(principal = "ed") {
  const sent: { target: string; env: Envelope }[] = [];
  const store = new PrincipalStore(mkdtempSync(join(tmpdir(), "trough-store-")), principal);
  store.settings.review = "auto";
  const steward = new Steward(store, { send: (target, env) => sent.push({ target, env }) });
  let n = 0;
  const msg = (from: string, kind: Received["kind"], data: Record<string, unknown> = {}, extra: Partial<Received> = {}): Received => ({
    kind,
    id: `m${++n}`,
    from,
    account: from.endsWith("|steward") ? "trough-steward" : from.split("|")[0],
    target: `${principal}|steward`,
    time: new Date().toISOString(),
    data,
    ...extra,
  });
  const last = (target?: string) => [...sent].reverse().find((s) => !target || s.target === target)!.env;
  return { sent, store, steward, msg, last };
}

test("hello registers the session with the default sharing and acks onboarding state", async () => {
  const { steward, msg, last } = setup();
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  assert.equal(last().kind, "ack");
  assert.equal(last().data?.onboarding, true);
  assert.equal(last().data?.shared, false);
});

test("checkpoints file onto the card their refs match, creating one the first time", async () => {
  const { steward, msg, last, store } = setup();
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "Started the k3s base image", title: "K3s base image", refs: [{ type: "ticket", value: "TR-16855" }] }));
  const first = last().data!;
  assert.equal(first.created, true);
  await steward.handle(msg("ed|cx-2", "hello", { agent: "codex" }));
  await steward.handle(msg("ed|cx-2", "checkpoint", { digest: "Reviewed the installer", refs: [{ type: "branch", value: "tooling/TR-16855-k3s" }] }));
  assert.equal(last().data!.card, first.card);
  const card = store.view(first.card as string, "owner")!;
  assert.equal(card.sessions.length, 2);
  assert.ok(card.refs.some((r) => r.type === "branch"));
});

test("WAL replays are idempotent", async () => {
  const { steward, msg, store } = setup();
  const m = msg("ed|cc-1", "checkpoint", { digest: "once", title: "Dedupe" });
  await steward.handle(m);
  await steward.handle(m);
  const id = store.cardIds()[0]!;
  assert.equal(store.view(id, "owner")!.digests.length, 1);
});

test("teammates only see shared sessions' published work", async () => {
  const { steward, msg, last, store } = setup();
  store.settings.defaultShared = false;
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "secret stuff about vector", title: "Vector churn" }));
  await steward.handle(msg("dan|cc-9", "recall", { text: "vector churn" }));
  assert.match(last("dan|cc-9").text!, /Not in anything ed has shared/);
  await steward.handle(msg("ed|cc-1", "control", { op: "share" }));
  await steward.handle(msg("dan|cc-9", "recall", { text: "vector churn" }));
  assert.equal((last("dan|cc-9").data!.cards as unknown[]).length, 1);
});

test("unshare hides the session and tells the other stewards", async () => {
  const { steward, msg, last, store } = setup();
  store.settings.defaultShared = true;
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "vector work", title: "Vector churn" }));
  await steward.handle(msg("ed|cc-1", "control", { op: "unshare" }));
  assert.equal(last(STEWARDS_CHANNEL).kind, "retract");
  await steward.handle(msg("ed|cc-1", "control", { op: "unshare" }));
  assert.equal(last("ed|cc-1").data!.changed, false);
  await steward.handle(msg("dan|cc-9", "recall", { text: "vector churn" }));
  assert.match(last("dan|cc-9").text!, /Not in anything/);
  // The owner still has it.
  await steward.handle(msg("ed|cc-1", "recall", { text: "vector churn" }));
  assert.equal((last("ed|cc-1").data!.cards as unknown[]).length, 1);
});

test("auto-after digests stay drafts for the team until due", async () => {
  const { steward, msg, last, store } = setup();
  store.settings.defaultShared = true;
  store.settings.review = "auto-after";
  store.settings.reviewDelayMs = 1000;
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "draft digest", title: "Drafty", refs: [{ type: "ticket", value: "X-12" }] }));
  const id = last("ed|cc-1").data!.card as string;
  assert.equal(store.view(id, "team")!.summary, "");
  steward.tick(Date.now() + 5000);
  assert.equal(store.view(id, "team")!.summary, "draft digest");
});

test("catchup summarises a window of shared activity", async () => {
  const { steward, msg, last, store } = setup();
  store.settings.defaultShared = true;
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "did things", title: "Thing one", decisions: ["use ergo"] }));
  await steward.handle(msg("dan|cc-9", "recall", { since: "1d" }));
  const r = last("dan|cc-9");
  assert.match(r.text!, /Thing one/);
  assert.deepEqual((r.data!.cards as { decisions: string[] }[])[0]!.decisions, ["use ergo"]);
});

test("asks go to a live session on the matching card, else are answered from the card", async () => {
  const { steward, msg, last, store, sent } = setup();
  store.settings.defaultShared = true;
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "ECW flyovers keep a black collar", title: "ECW black collar" }));
  await steward.handle(msg("dan|cc-9", "ask", {}, { text: "why does the ECW black collar happen?" }));
  const fwd = sent.find((s) => s.target === "ed|cc-1" && s.env.kind === "ask");
  assert.ok(fwd, "forwarded to the live session");
  assert.equal(fwd!.env.data!.asker, "dan|cc-9");
  steward.onGone("ed|cc-1");
  await steward.handle(msg("dan|cc-9", "ask", {}, { text: "why does the ECW black collar happen?" }));
  assert.match(last("dan|cc-9").text!, /ECW black collar/);
});

test("foreign activity sharing a ref raises a note to the live session on that card", async () => {
  const { steward, msg, sent, store } = setup();
  store.settings.relevance = "refs";
  await steward.handle(msg("ed|cc-1", "hello", { agent: "claude-code" }));
  await steward.handle(msg("ed|cc-1", "checkpoint", { digest: "vector", title: "Vector churn", refs: [{ type: "site", value: "home" }] }));
  await steward.handle(msg("dan|cc-9", "update", { refs: [{ type: "site", value: "home" }] }, { target: "#trough", text: "restarting vector at home" }));
  assert.ok(sent.some((s) => s.target === "ed|cc-1" && s.env.kind === "note"));
});

test("messages without a matching account are ignored", async () => {
  const { steward, msg, sent } = setup();
  await steward.handle(msg("ed|cc-1", "hello", { agent: "x" }, { account: "dan" }));
  assert.equal(sent.length, 0);
});

test("a message for a departed session goes to a live successor on the same card", async () => {
  const { steward, msg, sent, store } = setup();
  store.settings.defaultShared = true;
  for (const n of ["ed|pi-old", "ed|pi-new"]) await steward.handle(msg(n, "hello", { agent: "pi" }));
  await steward.handle(msg("ed|pi-old", "checkpoint", { digest: "trough pi work", title: "Pi integration", refs: [{ type: "ticket", value: "TR-1" }] }));
  await steward.handle(msg("ed|pi-new", "checkpoint", { digest: "picked it up", refs: [{ type: "ticket", value: "TR-1" }] }));
  steward.onGone("ed|pi-old");
  await steward.handle(msg("dan|cc-9", "steer", { undeliverable: { to: "ed|pi-old" } }, { text: "hold off on mcp.ts" }));
  const fwd = sent.find((s) => s.target === "ed|pi-new" && s.env.kind === "steer");
  assert.match(fwd!.env.text!, /originally for ed\|pi-old.*hold off/);
  assert.equal(fwd!.env.data!.asker, "dan|cc-9");
  assert.match(sent.at(-1)!.env.text!, /passed to ed\|pi-new/);
});

test("with no successor it's held on the card and handed to the next session that attaches", async () => {
  const { steward, msg, sent, store } = setup();
  store.settings.defaultShared = true;
  await steward.handle(msg("ed|pi-old", "hello", { agent: "pi" }));
  await steward.handle(msg("ed|pi-old", "checkpoint", { digest: "trough pi work", title: "Pi integration", refs: [{ type: "ticket", value: "TR-1" }] }));
  steward.onGone("ed|pi-old");
  await steward.handle(msg("dan|cc-9", "ask", { undeliverable: { to: "ed|pi-old" } }, { text: "did the wake land?" }));
  const r = sent.at(-1)!.env;
  assert.match(r.text!, /held there/);
  assert.match(r.text!, /Pi integration/, "an ask is answered from the card meanwhile");
  await steward.handle(msg("ed|pi-next", "hello", { agent: "pi" }));
  await steward.handle(msg("ed|pi-next", "checkpoint", { digest: "back on it", refs: [{ type: "ticket", value: "TR-1" }] }));
  const delivered = sent.filter((s) => s.target === "ed|pi-next" && s.env.kind === "ask");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!.env.text!, /held for you.*did the wake land/);
  await steward.handle(msg("ed|pi-next2", "checkpoint", { digest: "again", refs: [{ type: "ticket", value: "TR-1" }] }));
  assert.equal(sent.filter((s) => s.target === "ed|pi-next2" && s.env.kind === "ask").length, 0, "delivered once");
});

test("a departed session with no cards gets a plain not-delivered", async () => {
  const { steward, msg, sent } = setup();
  await steward.handle(msg("dan|cc-9", "steer", { undeliverable: { to: "ed|cx-ghost" } }, { text: "hi" }));
  assert.match(sent.at(-1)!.env.text!, /left no cards/);
});
