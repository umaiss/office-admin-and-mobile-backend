import { Logger, Module } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { LocalDiskStorageService } from './local-disk.storage';
import { S3StorageService } from './s3.storage';
import { StorageService } from './storage.service';

/**
 * Binds the storage abstraction to whichever driver `STORAGE_DRIVER` selects.
 *
 * This factory is the entire cost of the local↔S3 switch: everything above
 * `StorageService` — the tasks service, the controller, the `TaskReceipt` row —
 * is written against four methods and never learns which backend answered them.
 *
 * A factory rather than two modules because the choice is configuration, not
 * code: the same image ships to a laptop writing to `./uploads` and to EC2
 * writing to a bucket, and only the environment differs.
 *
 * Both drivers implement `OnModuleInit`; because they are constructed here,
 * Nest still calls it, so each one proves at boot that it can actually write.
 */
@Module({
  providers: [
    {
      provide: StorageService,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): StorageService => {
        const logger = new Logger('StorageModule');

        if (config.storageDriver === 's3') {
          logger.log(`Storage driver: s3 (bucket ${config.s3Bucket})`);
          return new S3StorageService(config);
        }

        logger.log(`Storage driver: local disk (${config.uploadsDir})`);
        return new LocalDiskStorageService(config);
      },
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
