import assert from "node:assert/strict";
import test from "node:test";
import { ACTIONS, runAction } from "../src/actions.ts";
import type { Session } from "../src/session.ts";

function fakeSession() {
  const calls: unknown[][] = [];
  const session = {
    nick: "ed|pi-ab12",
    principal: "ed",
    shared: false,
    defaultShared: null,
    authError: undefined,
    cards: new Set<string>(["c-1"]),
    roster: () => [],
    drawerItems: () => [],
    setFocus: (...args: unknown[]) => calls.push(args),
  } as unknown as Session;
  return { session, calls };
}

test("shared tool actions exclude human-only sharing controls", () => {
  assert.deepEqual(ACTIONS, ["status", "focus", "checkpoint", "update", "recall", "recipes", "catchup", "ask", "reply", "steer", "delegate", "inbox", "dismiss"]);
  assert.equal((ACTIONS as readonly string[]).includes("share"), false);
  assert.equal((ACTIONS as readonly string[]).includes("unshare"), false);
});

test("shared action handler formats status and routes focus", async () => {
  const { session, calls } = fakeSession();
  const status = await runAction(session, { action: "status" });
  assert.match(status, /ed\|pi-ab12, private; cards: c-1/);
  assert.match(status, /hasn't chosen a sharing default/);

  assert.equal(await runAction(session, { action: "focus", text: "reviewing PR", role: "reviewer" }), "Focus updated.");
  assert.deepEqual(calls, [["reviewing PR", "reviewer"]]);
});
