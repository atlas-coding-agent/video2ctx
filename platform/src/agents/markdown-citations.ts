import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTable } from 'micromark-extension-gfm-table';

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

function parseMarkdown(text: string) {
  return fromMarkdown(text, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });
}

/** Source offsets from the grammar preserve tables inside quotes and lists, and exclude code. */
export function tableRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  function visit(node: MarkdownNode) {
    if (node.type === 'table' && node.position) {
      ranges.push([node.position.start.offset!, node.position.end.offset!]);
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  }
  visit(parseMarkdown(text));
  return ranges;
}

/** Transform prose while copying code directly from the source, without reserializing Markdown.
 * `alsoProtect` copies further node types, such as links, unchanged as well. */
export function mapCitationProse(text: string, transform: (prose: string, start: number, end: number) => string, streaming = false,
  alsoProtect: readonly string[] = []): string {
  const protectedRanges: Array<[number, number]> = [];
  function visit(node: MarkdownNode, paragraphEnd = text.length) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'code' || node.type === 'inlineCode') {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const protectedStart = node.type === 'code' && /^[ \t]*$/.test(text.slice(lineStart, start)) ? lineStart : start;
      protectedRanges.push([protectedStart, end]);
      return;
    }
    if (alsoProtect.includes(node.type)) {
      protectedRanges.push([start, end]);
      return;
    }
    if (node.type === 'paragraph') paragraphEnd = end;
    if (streaming && node.type === 'text') {
      // An unmatched backtick is plain text in complete Markdown, but may still
      // become an inline code span as the stream grows. Preserve that paragraph
      // tail provisionally. Escaped backticks are ordinary prose.
      const raw = text.slice(start, end);
      const opener = [...raw.matchAll(/\\[\\`]|`+/g)].find(match => match[0].startsWith('`'));
      if (opener) protectedRanges.push([start + opener.index!, paragraphEnd]);
    }
    if ('children' in node) for (const child of node.children) visit(child, paragraphEnd);
  }
  visit(parseMarkdown(text));
  protectedRanges.sort((a, b) => a[0] - b[0]);
  let offset = 0;
  let result = '';
  for (const [start, end] of protectedRanges) {
    if (end <= offset) continue;
    if (start > offset) result += transform(text.slice(offset, start), offset, start);
    result += text.slice(Math.max(offset, start), end);
    offset = end;
  }
  return result + transform(text.slice(offset), offset, text.length);
}

/** Canonical citations used for evidence reads and persisted-answer validation. */
export function answerCitationIds(text: string): string[] {
  const ids = new Set<string>();
  mapCitationText(text, prose => {
    for (const match of prose.matchAll(/\[cite:([A-Za-z0-9:_-]+)\]/g)) ids.add(match[1]!);
    return prose;
  });
  return [...ids];
}

/** Appended citations must not join a fence delimiter or become code themselves. */
export function endsInCodeBlock(text: string): boolean {
  let last: MarkdownNode | undefined = parseMarkdown(text);
  while (last && 'children' in last) last = last.children.at(-1);
  return last?.type === 'code';
}

/** Trim only outer prose whitespace; indentation and trailing spaces in code are data. */
export function trimCitationProse(text: string, streaming = false): string {
  return mapCitationProse(text, (prose, start, end) => {
    if (start === 0) prose = prose.trimStart();
    if (end === text.length) prose = prose.trimEnd();
    return prose;
  }, streaming);
}

// Links, images and definitions are copied unchanged, so no citation lands inside a label or URL.
export const LINK_NODES = ['link', 'linkReference', 'image', 'imageReference', 'definition'] as const;

/** Text an alias form must not touch: bare URLs up to the next whitespace, and call-like text such
 * as fn(value, ref_1), outer(inner(ref_1)) or a call split across lines, from the name to its
 * matching parenthesis. Parentheses inside quoted strings, and escaped characters there, do not
 * count. Calls start only in prose. Scan the whole block, not each prose chunk, so inline code
 * or a line break inside a call cannot end it early. */
export function literalSpans(text: string, prose: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const urls = [...text.matchAll(/(?:\b[A-Za-z][A-Za-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/g)]
    .map((match): [number, number] => [match.index!, match.index! + match[0].length]);
  // Quotes describe literal text. Do not turn their contents into evidence links.
  // Apostrophes within words do not open a quotation.
  const quotes = [...text.matchAll(/(?<![\p{L}\p{N}_\\])(?:"(?:\\.|[^"\\\n])*"|“[^”\n]*”|'(?:\\.|[^'\\\n])*'|‘[^’\n]*’)/gu)]
    .map((match): [number, number] => [match.index!, match.index! + match[0].length]);
  const calls: Array<[number, number]> = [];
  for (const match of text.matchAll(/[A-Za-z_$][\w$.]*\(/g)) {
    const start = match.index!;
    // A call starts in prose. Text inside code or a link is already preserved.
    if (start < (calls.at(-1)?.[1] ?? 0) || !prose.some(([from, to]) => start >= from && start < to)) continue;
    let depth = 0;
    let quote = '';
    // An unclosed call ends at the next blank line, so it cannot hide later paragraphs.
    const paragraphEnd = text.slice(start).search(/\n[ \t]*\n/);
    const limit = paragraphEnd < 0 ? text.length : start + paragraphEnd;
    let end = limit;
    for (let index = start + match[0].length - 1; index < limit; index += 1) {
      const char = text[index]!;
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
        // Quoted strings end at a line break, except template strings, so a stray apostrophe
        // inside a call cannot hide its closing parenthesis on a later line.
        else if (char === '\n' && quote !== '`') quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) { end = index + 1; break; }
    }
    calls.push([start, end]);
  }
  return [...urls, ...quotes, ...calls];
}

/** Map actual citation text consistently during validation, persistence and display.
 * Literal notation is copied verbatim, even when it names a real evidence ID. */
export function mapCitationText(text: string, transform: (prose: string) => string): string {
  const prose: Array<[number, number]> = [];
  mapCitationProse(text, (chunk, start, end) => { prose.push([start, end]); return chunk; }, false, LINK_NODES);
  const literals = literalSpans(text, prose).sort((a, b) => a[0] - b[0]);
  return mapCitationProse(text, (chunk, start, end) => {
    let cursor = start, result = '';
    for (const [from, to] of literals) {
      if (to <= cursor || from >= end) continue;
      if (from > cursor) result += transform(text.slice(cursor, from));
      result += text.slice(Math.max(cursor, from), Math.min(end, to));
      cursor = Math.min(end, to);
    }
    return result + transform(text.slice(cursor, end));
  }, false, LINK_NODES);
}
