// Delivery levels (docs/PROTOCOL.md "Delivery levels and the drawer"): what reaches the
// model's transcript (inject), what only the human's drawer shows, and what's silent.

import type { Received } from "./protocol.ts";

export type Level = "inject" | "drawer" | "silent";

export interface Plain {
  plain: true;
  from: string;
  account?: string;
  target: string;
  text: string;
  time: string;
}

/**
 * 🐈 is the "(null)" reply: "seen, nothing to add". An LLM handed a message tends to answer
 * it, so two agents can thank each other forever; a lone cat ends the exchange. It's never
 * shown to the model and never answered. Same idea as pi-team-room's done signal.
 */
export const DONE = "🐈";

export function isDone(text: string | undefined): boolean {
  return (text ?? "").trim() === DONE;
}

/** Back-and-forth between agents without a human in the loop stops reaching the model here. */
export const MAX_DEPTH = 6;

export function classify(msg: Received | Plain, myNick: string): Level {
  const toMe = msg.target.toLowerCase() === myNick.toLowerCase();
  if ("plain" in msg) {
    // A human (or bot) talking to this session directly is worth the model's attention.
    return toMe ? "inject" : "drawer";
  }
  if (msg.from.toLowerCase() === myNick.toLowerCase()) return "silent"; // own echo
  if (isDone(msg.text)) return "drawer";
  // A long agent-to-agent thread goes to the drawer so a human can decide whether it continues.
  if (Number(msg.data?.depth ?? 0) >= MAX_DEPTH) return "drawer";
  switch (msg.kind) {
    case "ack":
    case "retract":
    case "control":
      return "silent";
    case "steer":
    case "delegate":
    case "ask":
    case "note":
      return toMe ? "inject" : "drawer";
    case "reply":
      // Replies the caller is still awaiting never get here (Session consumes them), so
      // anything left is a late answer, e.g. a teammate's session answering a forwarded ask.
      return toMe ? "inject" : "drawer";
    default:
      return "drawer";
  }
}
