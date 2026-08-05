import type { Readable } from 'node:stream';

/** What a driver returns once bytes are safely at rest. */
export interface StoredFile {
  /**
   * Opaque locator. Meaningful only to the driver that produced it — a relative
   * path for local disk, an object key for S3. Callers persist it and hand it
   * back; they never parse or construct one.
   */
  key: string;
  sizeBytes: number;
  mimeType: string;
}

/** What the caller knows about the bytes it is handing over. */
export interface SaveFileOptions {
  /** Verified type (sniffed from the bytes, not the client's claim). */
  mimeType: string;
  /**
   * The client's filename. Used ONLY to pick a sensible extension and to be
   * echoed back on download. Never used to build the storage key — see
   * `LocalDiskStorageService` for why that distinction matters.
   */
  originalName: string;
  /** Logical grouping, e.g. `receipts`. Drivers may use it as a prefix. */
  namespace: string;
}

/**
 * The seam between "we have some bytes" and "the bytes live somewhere".
 *
 * ## Why an abstract class rather than an interface
 *
 * Nest resolves constructor dependencies at runtime from the metadata
 * TypeScript emits. An `interface` is erased at compile time, leaving nothing to
 * inject against; an abstract class exists at runtime, so it works as both the
 * type and the DI token. (The same reasoning as `AppConfigService` — see the
 * comment at the top of that file.)
 *
 * ## Why the seam exists at all
 *
 * Receipts live on local disk today, because the app runs on one EC2 box behind
 * nginx and a mounted volume is the honest answer for that shape. The moment
 * there are two boxes, local disk stops working and object storage is the only
 * option. Everything above this class — the controller, the service, the
 * `TaskReceipt` row — is written against these four methods, so that migration
 * is one new provider class and a one-line change in `storage.module.ts`.
 */
export abstract class StorageService {
  /** Writes bytes and returns their locator. Generates the key itself. */
  abstract save(buffer: Buffer, options: SaveFileOptions): Promise<StoredFile>;

  /** Opens a stream for reading. Throws `NotFoundException` if the key is gone. */
  abstract createReadStream(key: string): Promise<Readable>;

  /**
   * Removes the object. Deliberately forgiving about an already-missing key:
   * deletes run as cleanup after the database row is gone, and turning "the
   * file was already deleted" into an error would fail requests that in fact
   * achieved exactly what was asked.
   */
  abstract delete(key: string): Promise<void>;

  abstract exists(key: string): Promise<boolean>;
}
