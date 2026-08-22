/**
 * Truncate a string to a fixed width by keeping the head and tail and
 * replacing the middle with a marker.
 *
 * Width is measured in UTF-16 code units (`String.prototype.length`
 * semantics), which is what the UI layer (widgets, trace lines) uses for
 * terminal column budgeting.
 */
export function truncateMiddle(text: string, maxWidth: number, marker = "…"): string {
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= marker.length) {
    return marker.slice(0, maxWidth);
  }
  const prefixLength = Math.ceil((maxWidth - marker.length) / 2);
  const suffixLength = maxWidth - marker.length - prefixLength;
  return text.slice(0, prefixLength) + marker + text.slice(text.length - suffixLength);
}
