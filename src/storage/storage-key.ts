import { randomUUID } from 'node:crypto';

import {
  ALLOWED_RECEIPT_MIME_TYPES,
  MIME_TYPE_EXTENSIONS,
  type AllowedReceiptMimeType,
} from './file-type';

/**
 * Builds the locator a stored file is filed under.
 *
 * Shared by every driver on purpose. If local disk and S3 each invented their
 * own scheme, the keys already in the database would stop resolving the moment
 * you switched drivers — and migrating the existing files would mean rewriting
 * every `TaskReceipt.storageKey` row rather than just copying objects across.
 *
 * Two properties matter:
 *
 *  1. **Nothing from the client reaches it.** The name is a UUID and the
 *     extension comes from the SNIFFED type, so an upload called
 *     `../../etc/passwd` is stored as `receipts/2026/08/<uuid>.jpg` and the
 *     original name survives only as display metadata.
 *  2. **It is date-sharded.** One directory holding every receipt ever uploaded
 *     gets slow on a filesystem; on S3 the prefix spread also helps. Year/month
 *     is coarse enough to stay human-navigable when someone has to go looking.
 */
export function buildStorageKey(
  namespace: string,
  mimeType: string,
  now: Date = new Date(),
): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  return `${namespace}/${year}/${month}/${randomUUID()}.${extensionFor(mimeType)}`;
}

/**
 * Extension for a verified mime type. Falls back to `bin` for a type outside
 * the allowlist, which the upload path rejects before reaching here — the
 * fallback exists so this function is total, not because it should ever run.
 */
export function extensionFor(mimeType: string): string {
  return ALLOWED_RECEIPT_MIME_TYPES.includes(mimeType as AllowedReceiptMimeType)
    ? MIME_TYPE_EXTENSIONS[mimeType as AllowedReceiptMimeType]
    : 'bin';
}
