import { randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import {
  ALLOWED_RECEIPT_MIME_TYPES,
  MIME_TYPE_EXTENSIONS,
  type AllowedReceiptMimeType,
} from './file-type';
import {
  StorageService,
  type SaveFileOptions,
  type StoredFile,
} from './storage.service';

/**
 * Stores files on the local filesystem, under `UPLOADS_DIR`.
 *
 * Right for the current deployment — one EC2 host, nginx in front, a mounted
 * volume — and wrong the moment there is a second host, at which point
 * `storage.module.ts` swaps in an S3 driver and nothing above this file changes.
 *
 * ## The two rules this class exists to enforce
 *
 * 1. **The client never influences the path.** Keys are built from a server-side
 *    UUID and the sniffed type. A filename of `../../../.env` is stored as a
 *    display string and never touches `path.join`.
 * 2. **Every read is fenced.** Even though keys are generated here, `read` and
 *    `delete` take a key that has round-tripped through the database, so they
 *    re-verify that the resolved absolute path is still inside `UPLOADS_DIR`
 *    before touching the disk. Defence in depth: a bug or a bad migration that
 *    put `..` into a `storageKey` cannot become an arbitrary file read.
 */
@Injectable()
export class LocalDiskStorageService
  extends StorageService
  implements OnModuleInit
{
  private readonly logger = new Logger(LocalDiskStorageService.name);

  /** Absolute, symlink-free root. Every resolved path must live under it. */
  private readonly root: string;

  constructor(private readonly config: AppConfigService) {
    super();
    this.root = path.resolve(this.config.uploadsDir);
  }

  /**
   * Creates the root eagerly at boot rather than lazily on first upload, so a
   * misconfigured or unwritable volume fails the deployment instead of failing
   * the first office boy who tries to attach a receipt.
   *
   * The WRITE check is the part that earns its place. `mkdir` with
   * `recursive: true` succeeds silently on a directory that already exists, so
   * on its own it proves only that the path is there — not that this process can
   * put anything in it. A Docker named volume mounted at a path the image never
   * created is owned by root, and a container running as `node` passes the mkdir
   * and then fails every upload. Checking `W_OK` turns that into a container
   * that refuses to start, which is a deploy failure someone notices rather than
   * a 500 an office boy discovers.
   */
  async onModuleInit(): Promise<void> {
    await mkdir(this.root, { recursive: true });

    try {
      await access(this.root, constants.W_OK);
    } catch {
      throw new Error(
        `Receipt storage at ${this.root} is not writable by this process. ` +
          'If running in Docker, the uploads volume is likely owned by root ' +
          'while the container runs as `node` — see the mkdir/chown in the ' +
          'Dockerfile runtime stage.',
      );
    }

    this.logger.log(`Receipt storage ready at ${this.root}`);
  }

  async save(buffer: Buffer, options: SaveFileOptions): Promise<StoredFile> {
    // Date-sharded so one directory does not accumulate every receipt ever
    // uploaded; filesystems slow down badly with hundreds of thousands of
    // entries in a single directory.
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    const extension = extensionFor(options.mimeType);
    const key = `${options.namespace}/${year}/${month}/${randomUUID()}.${extension}`;

    const absolute = this.resolveKey(key);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);

    return { key, sizeBytes: buffer.byteLength, mimeType: options.mimeType };
  }

  async createReadStream(key: string): Promise<Readable> {
    const absolute = this.resolveKey(key);

    if (!(await this.existsAt(absolute))) {
      // The row says there is a file and there is not. That is a real
      // inconsistency worth logging, but from the caller's side it is a 404.
      this.logger.warn(`Receipt missing from disk: ${key}`);
      throw new NotFoundException('Receipt file is no longer available.');
    }

    return createReadStream(absolute);
  }

  async delete(key: string): Promise<void> {
    const absolute = this.resolveKey(key);
    try {
      await unlink(absolute);
    } catch (error) {
      // Already gone is success — see the contract on StorageService.delete.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.existsAt(this.resolveKey(key));
  }

  // --------------------------------------------------------------------------
  //  Internals
  // --------------------------------------------------------------------------
  /**
   * Turns a storage key into an absolute path, refusing anything that escapes
   * the root.
   *
   * `path.resolve` collapses `..` segments, so the comparison below is against
   * the real destination rather than the literal string. The trailing separator
   * on the prefix check matters: without it, an `UPLOADS_DIR` of `/data/uploads`
   * would also accept `/data/uploads-evil/x`.
   */
  private resolveKey(key: string): string {
    const absolute = path.resolve(this.root, key);

    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      throw new NotFoundException('Receipt file is no longer available.');
    }

    return absolute;
  }

  private async existsAt(absolutePath: string): Promise<boolean> {
    try {
      const stats = await stat(absolutePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }
}

/**
 * Extension for a verified mime type. Falls back to `bin` for a type outside
 * the allowlist, which the upload path rejects before reaching here — the
 * fallback exists so this function is total, not because it should ever run.
 */
function extensionFor(mimeType: string): string {
  return ALLOWED_RECEIPT_MIME_TYPES.includes(mimeType as AllowedReceiptMimeType)
    ? MIME_TYPE_EXTENSIONS[mimeType as AllowedReceiptMimeType]
    : 'bin';
}
