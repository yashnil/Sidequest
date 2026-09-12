/**
 * V9.1 §8 — A SMALL RFC 5545 READER, FOR TESTS.
 *
 * The calendar writer (`packages/core/src/execution/calendar.ts`) is tested
 * by reading its bytes back the way Apple, Google and Outlook do: unfold the
 * physical lines, split each logical line into a name, its parameters and
 * its value, and walk the `BEGIN`/`END` nesting into components. Nothing here
 * interprets dates or zones — a test asserts on the text the client would
 * parse, which is the contract. No dependency, no I/O.
 *
 * Also exposes the syntax checks a client is strict about and a reader is
 * lenient about, so a defect is named rather than absorbed: a physical line
 * over 75 octets, a bare LF, a missing final CRLF, an unmatched BEGIN.
 */
export interface IcsProperty {
  /** Upper-cased property name, e.g. `DTSTART`. */
  name: string;
  /** Parameter values keyed by upper-cased name, quotes removed. */
  params: Record<string, string>;
  /** The value exactly as written (escapes intact). */
  value: string;
  /** The logical line this came from. */
  raw: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

/** RFC 5545 §3.1: the physical line limit, in octets, excluding the CRLF. */
export const ICS_MAX_LINE_OCTETS = 75;

/** Physical lines, split on CRLF only. A trailing CRLF produces no empty last line. */
export function rawIcsLines(text: string): string[] {
  const lines = text.split('\r\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** UTF-8 octets of one physical line. */
export function octetLength(line: string): number {
  return Buffer.byteLength(line, 'utf8');
}

/** Logical lines: a physical line starting with a space or tab continues the previous one. */
export function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const line of rawIcsLines(text)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** One logical line into name, parameters and value (RFC 5545 §3.2; quoted parameter values may hold `:` `;` `,`). */
export function parseIcsLine(line: string): IcsProperty {
  let i = 0;
  const readName = (): string => {
    const start = i;
    while (i < line.length && /[A-Za-z0-9-]/.test(line[i]!)) i += 1;
    return line.slice(start, i).toUpperCase();
  };
  const name = readName();
  if (name.length === 0) throw new Error(`Not an iCalendar content line: ${JSON.stringify(line)}`);
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i += 1;
    const key = readName();
    if (line[i] !== '=') throw new Error(`Parameter without a value on ${name}: ${JSON.stringify(line)}`);
    i += 1;
    let value: string;
    if (line[i] === '"') {
      i += 1;
      const close = line.indexOf('"', i);
      if (close < 0) throw new Error(`Unterminated quoted parameter on ${name}: ${JSON.stringify(line)}`);
      value = line.slice(i, close);
      i = close + 1;
    } else {
      const start = i;
      while (i < line.length && line[i] !== ';' && line[i] !== ':') i += 1;
      value = line.slice(start, i);
    }
    params[key] = value;
  }
  if (line[i] !== ':') throw new Error(`Content line has no value separator: ${JSON.stringify(line)}`);
  return { name, params, value: line.slice(i + 1), raw: line };
}

/** The `\\` `\;` `\,` `\n` escapes of RFC 5545 §3.3.11, undone. */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** True when the value still holds a comma or semicolon that is not escaped. */
export function hasUnescapedSeparator(value: string): boolean {
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ',' || ch === ';') return true;
  }
  return false;
}

/** The whole document as one root component (the `VCALENDAR`). Throws on unbalanced nesting. */
export function parseIcs(text: string): IcsComponent {
  const stack: IcsComponent[] = [];
  let root: IcsComponent | null = null;
  for (const logical of unfoldIcs(text)) {
    if (logical.length === 0) continue;
    const property = parseIcsLine(logical);
    if (property.name === 'BEGIN') {
      const component: IcsComponent = { name: property.value.toUpperCase(), properties: [], components: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.components.push(component);
      else if (root) throw new Error(`A second top-level component: ${component.name}`);
      else root = component;
      stack.push(component);
      continue;
    }
    if (property.name === 'END') {
      const open = stack.pop();
      if (!open) throw new Error(`END:${property.value} with nothing open`);
      if (open.name !== property.value.toUpperCase()) throw new Error(`END:${property.value} closes ${open.name}`);
      continue;
    }
    const current = stack[stack.length - 1];
    if (!current) throw new Error(`Property outside any component: ${property.name}`);
    current.properties.push(property);
  }
  if (stack.length > 0) throw new Error(`Unclosed component: ${stack[stack.length - 1]!.name}`);
  if (!root) throw new Error('No component in the document');
  return root;
}

/** Every component of a name, at any depth, in document order. */
export function findComponents(component: IcsComponent, name: string): IcsComponent[] {
  const out: IcsComponent[] = [];
  const walk = (c: IcsComponent) => {
    if (c.name === name.toUpperCase()) out.push(c);
    for (const child of c.components) walk(child);
  };
  walk(component);
  return out;
}

export function properties(component: IcsComponent, name: string): IcsProperty[] {
  const wanted = name.toUpperCase();
  return component.properties.filter((p) => p.name === wanted);
}

export function property(component: IcsComponent, name: string): IcsProperty | undefined {
  return properties(component, name)[0];
}

/**
 * What a strict client would reject, one sentence each. Empty means the
 * physical layer is sound: CRLF line ends, a final CRLF, every line within 75
 * octets, and balanced components.
 */
export function icsSyntaxDefects(text: string): string[] {
  const defects: string[] = [];
  if (!text.endsWith('\r\n')) defects.push('The document does not end with CRLF.');
  if (/(^|[^\r])\n/.test(text)) defects.push('A bare LF is present; every line end must be CRLF.');
  if (/\r(?!\n)/.test(text)) defects.push('A bare CR is present.');
  rawIcsLines(text).forEach((line, index) => {
    const octets = octetLength(line);
    if (octets > ICS_MAX_LINE_OCTETS) defects.push(`Line ${index + 1} is ${octets} octets (limit ${ICS_MAX_LINE_OCTETS}): ${line.slice(0, 40)}…`);
  });
  try {
    parseIcs(text);
  } catch (error) {
    defects.push(error instanceof Error ? error.message : String(error));
  }
  return defects;
}
