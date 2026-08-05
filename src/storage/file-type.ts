/**
 * Identifying an uploaded file from its bytes.
 *
 * ## Why not just trust `file.mimetype`
 *
 * That value is the `Content-Type` the *client* wrote into the multipart part.
 * It is a claim, not a fact. `curl -F 'file=@shell.php;type=image/jpeg'` sets it
 * to whatever the caller likes. Nest's `FileTypeValidator` checks the same
 * claim, so it too can be defeated by renaming a file.
 *
 * Checking the leading bytes — the "magic number" every one of these formats
 * begins with — is what actually establishes the type. It is not a complete
 * defence on its own (a valid JPEG can carry a payload in its metadata), which
 * is exactly why the receipts are also stored outside the web root, served only
 * through an authorised handler, and never executed.
 */

/** The formats a receipt may be. Anything else is rejected. */
export const ALLOWED_RECEIPT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedReceiptMimeType =
  (typeof ALLOWED_RECEIPT_MIME_TYPES)[number];

/** Canonical file extension per accepted type, used to build the storage key. */
export const MIME_TYPE_EXTENSIONS: Record<AllowedReceiptMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Reads the real type out of a buffer's leading bytes, or `null` if it is none
 * of the formats we accept.
 *
 * Signatures:
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WebP  52 49 46 46 ?? ?? ?? ?? 57 45 42 50   ("RIFF" .... "WEBP")
 *   PDF   25 50 44 46                            ("%PDF")
 */
export function sniffMimeType(buffer: Buffer): AllowedReceiptMimeType | null {
  if (buffer.length < 12) {
    return null;
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP is a RIFF container; bytes 4-7 are the chunk length, so they are
  // skipped and the format tag at offset 8 is what identifies it.
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (buffer.toString('ascii', 0, 4) === '%PDF') {
    return 'application/pdf';
  }

  return null;
}
