import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decide, expandRefs, rank } from "../src/match.ts";
import { scrub } from "../src/scrub.ts";
import type { Card } from "../src/store.ts";
import { Wal } from "../src/wal.ts";

test("scrub removes secrets but keeps useful ids", () => {
  const sha = "0168e7fe79a1b2c3d4e5f60718293a4b5c6d7e8f";
  const out = scrub(`export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 password: hunter22hunter22 commit ${sha} key AKIAABCDEFGHIJKLMNOP url https://bob:s3cret@example.com/x`);
  assert.ok(!out.includes("ghp_"));
  assert.ok(!out.includes("hunter22"));
  assert.ok(!out.includes("AKIA"));
  assert.ok(!out.includes("s3cret"));
  assert.ok(out.includes(sha));
});

test("scrub leaves ordinary tool output alone", () => {
  const text = "NAME READY STATUS\nvector-abc 1/1 Running\n/var/lib/vector/checkpoints.json 52M";
  assert.equal(scrub(text), text);
});

function card(partial: Partial<Card>): Card {
  return { id: "c-1", owner: "ed", kind: "task", title: "", status: "active", refs: [], summary: "", digests: [], decisions: [], questions: [], recipes: [], updates: [], sessions: [], links: [], dismissed: [], createdAt: "", updatedAt: "", ...partial };
}

test("branch implies its ticket", () => {
  assert.deepEqual(expandRefs([{ type: "branch", value: "tooling/TR-16855-k3s" }]).at(-1), { type: "ticket", value: "TR-16855" });
});

test("a branch finds the card holding its ticket", () => {
  const cards = [card({ id: "a", refs: [{ type: "ticket", value: "TR-16855" }] }), card({ id: "b", refs: [{ type: "ticket", value: "TR-1" }] })];
  const { match } = decide(rank(cards, { refs: [{ type: "branch", value: "tooling/TR-16855-k3s" }] }));
  assert.equal(match?.card.id, "a");
});

test("pr-review cards are keyed by their pr ref", () => {
  const cards = [card({ id: "p1", kind: "pr-review", refs: [{ type: "pr", value: "initialed85/trough#7863" }] })];
  assert.equal(decide(rank(cards, { refs: [{ type: "pr", value: "https://github.com/initialed85/trough/pull/7863" }] })).match?.card.id, "p1");
  assert.equal(decide(rank(cards, { refs: [{ type: "pr", value: "initialed85/trough#7864" }] })).match, undefined);
});

test("two equally good cards are ambiguous", () => {
  const cards = [card({ id: "a", refs: [{ type: "site", value: "home" }, { type: "repo", value: "trough" }] }), card({ id: "b", refs: [{ type: "site", value: "home" }, { type: "repo", value: "trough" }] })];
  const d = decide(rank(cards, { refs: [{ type: "site", value: "home" }, { type: "repo", value: "trough" }], text: "" }));
  assert.equal(d.match, undefined);
});

test("WAL keeps unacked entries across restarts", () => {
  const path = join(mkdtempSync(join(tmpdir(), "trough-wal-")), "s.jsonl");
  const w = new Wal(path);
  w.append("ed|steward", { kind: "checkpoint", id: "1" });
  w.append("ed|steward", { kind: "checkpoint", id: "2" });
  w.ack("1");
  assert.deepEqual(new Wal(path).unacked().map((e) => e.env.id), ["2"]);
});
