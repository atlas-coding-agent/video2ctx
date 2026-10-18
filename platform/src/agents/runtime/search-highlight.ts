export type MatchMarkers = { start: string; end: string };

/**
 * Markers FTS5 highlight() places around matched tokens. Indexed text is untrusted and may
 * contain any fixed character, so each query uses fresh random markers, and an offset is
 * accepted only when the row's own content does not contain them.
 */
export function matchMarkers(): MatchMarkers {
  const nonce = crypto.randomUUID();
  return { start: `[[match-start:${nonce}]]`, end: `[[match-end:${nonce}]]` };
}

/**
 * Offset of the first matched token in indexed content, from FTS5 highlight(). Text before
 * the first marker is unmodified content, so its length is the original offset. Returns
 * undefined unless removing the markers reproduces the content exactly.
 */
export function firstMatchOffset(row: { content: string; marked?: string; markers?: MatchMarkers }): number | undefined {
  const { marked, markers, content } = row;
  if (!marked || !markers || content.includes(markers.start) || content.includes(markers.end)) return undefined;
  if (marked.split(markers.start).join('').split(markers.end).join('') !== content) return undefined;
  const at = marked.indexOf(markers.start);
  return at >= 0 ? at : undefined;
}
