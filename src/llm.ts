// Optional small-model calls for the steward (relevance tier 3, composing answers).
// Any OpenAI-compatible chat completions endpoint: a local llama-server, a shared one,
// or a hosted API. With no URL configured the steward stays fully deterministic.

export interface LlmConfig {
  url: string;
  model: string;
  apiKey?: string;
}

export function llmFromEnv(env = process.env): LlmConfig | undefined {
  if (!env.TROUGH_LLM_URL) return undefined;
  return { url: env.TROUGH_LLM_URL.replace(/\/+$/, ""), model: env.TROUGH_LLM_MODEL || "default", apiKey: env.TROUGH_LLM_KEY };
}

export async function complete(cfg: LlmConfig, system: string, user: string, maxTokens = 300): Promise<string | undefined> {
  try {
    const res = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Tier 3: would this event change what the card's session does next? */
export async function judgeRelevance(cfg: LlmConfig, cardSummary: string, event: string): Promise<{ relevant: boolean; why: string }> {
  const answer = await complete(
    cfg,
    "You triage background team chatter for a coding agent. Answer with YES or NO, then one short line of why. Say YES only if the event would change what the agent working on this card does next, answers one of its open questions, or contradicts one of its decisions.",
    `Card:\n${cardSummary}\n\nEvent:\n${event}`,
    80,
  );
  if (!answer) return { relevant: false, why: "no model answer" };
  return { relevant: /^\s*yes/i.test(answer), why: answer.replace(/^\s*(yes|no)[\s.:,-]*/i, "").slice(0, 200) };
}
