/**
 * ONE JSON OBJECT OUT OF A MODEL'S VISIBLE TEXT — DETERMINISTICALLY.
 *
 * Prompt-enforced JSON is a legitimate production path, and a completed,
 * paid answer must not be thrown away because the model wrapped it. This
 * extractor accepts the harmless deviations a model actually produces:
 * surrounding whitespace, a ```json fence, an XML wrapper such as
 * <trip_draft_json>…</trip_draft_json>, a sentence before or after the
 * object. It never guesses at content: it finds the first `{` from which a
 * *balanced* object parses (string- and escape-aware), and refuses when
 * there is none, when the object is truncated, or when what balances is not
 * valid JSON. No regex grabs arbitrary braces; no second model call.
 */
export type JsonSource = 'bare' | 'fenced' | 'wrapped' | 'embedded';

export type JsonExtraction =
  | { ok: true; json: unknown; source: JsonSource; start: number; end: number }
  | { ok: false; reason: 'empty' | 'no_object' | 'truncated' | 'invalid_json'; detail: string };

/** Index just past the `}` that balances the `{` at `start`, or -1 when the text ends first. */
export function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function extractJsonObject(input: string, options: { wrapperTag?: string } = {}): JsonExtraction {
  const text = input ?? '';
  if (!text.trim()) return { ok: false, reason: 'empty', detail: 'the response carried no visible text' };

  // 1. An explicit wrapper wins: what is inside it is the payload, whatever surrounds it.
  const candidates: { body: string; source: JsonSource; offset: number }[] = [];
  if (options.wrapperTag) {
    const open = text.indexOf(`<${options.wrapperTag}>`);
    const close = text.lastIndexOf(`</${options.wrapperTag}>`);
    if (open >= 0 && close > open) {
      candidates.push({ body: text.slice(open + options.wrapperTag.length + 2, close), source: 'wrapped', offset: open + options.wrapperTag.length + 2 });
    }
  }
  // 2. A fenced block.
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
  if (fence && fence[1] !== undefined) candidates.push({ body: fence[1], source: 'fenced', offset: fence.index + fence[0].indexOf(fence[1]) });
  // 3. The whole text as-is.
  candidates.push({ body: text, source: text.trim().startsWith('{') && text.trim().endsWith('}') ? 'bare' : 'embedded', offset: 0 });

  let sawTruncated = false;
  let sawInvalid: string | null = null;
  for (const candidate of candidates) {
    let from = candidate.body.indexOf('{');
    while (from >= 0) {
      const end = balancedObjectEnd(candidate.body, from);
      if (end < 0) {
        sawTruncated = true;
        break;
      }
      const slice = candidate.body.slice(from, end);
      try {
        const json = JSON.parse(slice) as unknown;
        if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
          return { ok: true, json, source: candidate.source, start: candidate.offset + from, end: candidate.offset + end };
        }
      } catch (error) {
        sawInvalid = error instanceof Error ? error.message.slice(0, 160) : 'invalid JSON';
      }
      from = candidate.body.indexOf('{', from + 1);
    }
  }
  if (sawTruncated) return { ok: false, reason: 'truncated', detail: 'an object opened but the text ended before it closed' };
  if (sawInvalid) return { ok: false, reason: 'invalid_json', detail: sawInvalid };
  return { ok: false, reason: 'no_object', detail: 'no JSON object in the visible text' };
}
