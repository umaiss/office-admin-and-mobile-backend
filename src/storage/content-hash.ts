import { createHash } from 'node:crypto';

/**
 * SHA-256 of a stored file's bytes, hex encoded.
 *
 * The identity of a receipt for duplicate-detection purposes. Lives here rather
 * than inside the petty cash module because BOTH receipt paths have to produce
 * it the same way — an office boy's task receipt and an admin's scanned receipt
 * are the same photo if their bytes match, and a duplicate check that only
 * hashed one of them would miss exactly the case worth catching.
 */
export function contentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
