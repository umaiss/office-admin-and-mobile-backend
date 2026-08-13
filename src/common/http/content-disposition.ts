/**
 * Makes an uploaded filename safe to place inside a `Content-Disposition`
 * header.
 *
 * A filename is attacker-controlled text. Left as-is, a name containing `"` or
 * a CRLF would break out of the quoted string and let the uploader append
 * arbitrary response headers. Stripping quotes, backslashes and control
 * characters — and capping the length — removes that entirely; the result is
 * only ever a display hint.
 */
export function sanitiseFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return (cleaned || 'receipt').slice(0, 100);
}

/**
 * The `Content-Disposition` value for a file the browser should render rather
 * than download.
 *
 * `inline` so the dashboard can show a receipt in an `<img>`/`<iframe>` instead
 * of forcing a save dialog. Lives here, next to the sanitiser, so no caller can
 * build the header while forgetting to clean the name — which is exactly how
 * the petty-cash download ended up unsanitised while the task download was not.
 */
export function inlineContentDisposition(originalName: string): string {
  return `inline; filename="${sanitiseFilename(originalName)}"`;
}
