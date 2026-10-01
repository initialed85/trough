// The one mandatory filter on anything leaving the owner's machine: secrets.
// Runs client-side before a digest, recipe or update is sent. Deliberately
// over-eager; a false positive costs a "[redacted]", a false negative leaks a key.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic / OpenAI style
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, // credentials in URLs
];

// KEY=value / key: value where the key looks secret-ish (.env dumps, YAML, CLI flags).
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*|\s+)(["']?)([^\s"']{4,})\3/gi;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, random-looking tokens (hex/base64) that no pattern caught. */
const CANDIDATE = /\b[A-Za-z0-9+/_=-]{32,}\b/g;

export function scrub(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[redacted]");
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string, q: string) => `${key}${sep}${q}[redacted]${q}`);
  out = out.replace(CANDIDATE, (tok) => {
    // Leave git SHAs, UUID-ish ids and paths alone; they're useful and not secret.
    if (/^[0-9a-f]{40}$/.test(tok) || /^[0-9a-f]{64}$/.test(tok)) return tok;
    if (tok.includes("/") && !/[+=]/.test(tok)) return tok;
    return entropy(tok) >= 4.2 ? "[redacted]" : tok;
  });
  return out;
}

/** Scrub every string inside a JSON-ish value. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)])) as T;
  }
  return value;
}
