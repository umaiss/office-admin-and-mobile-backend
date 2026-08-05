import { Module } from '@nestjs/common';

import { LocalDiskStorageService } from './local-disk.storage';
import { StorageService } from './storage.service';

/**
 * Binds the storage abstraction to a concrete driver.
 *
 * This one-line provider mapping is the entire cost of moving receipts to
 * object storage later: write `S3StorageService extends StorageService`, change
 * `useClass` here, and every consumer keeps compiling. Nothing else in the
 * codebase mentions the filesystem.
 */
@Module({
  providers: [{ provide: StorageService, useClass: LocalDiskStorageService }],
  exports: [StorageService],
})
export class StorageModule {}
