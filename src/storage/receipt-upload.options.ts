import { memoryStorage } from 'multer';

/**
 * multer config shared by every receipt upload route.
 *
 * `memoryStorage` rather than disk: the bytes have to be inspected (magic-byte
 * sniff) and handed to `StorageService`, which may not be a filesystem at all.
 * Writing them to a temp file first would add a second place they can leak from.
 *
 * `fileSize` is a hard stop applied while the stream is read, so an oversized
 * upload is aborted mid-transfer instead of being buffered in full and then
 * rejected — the difference between a bounded and an unbounded memory cost.
 * `files: 1` stops a caller sending a hundred parts under the same field name.
 *
 * The 5 MB literal duplicates the `MAX_RECEIPT_BYTES` default because decorator
 * arguments are evaluated at class-definition time, before Nest can inject
 * config. Each service re-checks against the configured value, so a deployment
 * that lowers the limit is still enforced.
 */
export const RECEIPT_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
};
