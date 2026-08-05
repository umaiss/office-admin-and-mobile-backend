import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { buildStorageKey } from './storage-key';
import {
  StorageService,
  type SaveFileOptions,
  type StoredFile,
} from './storage.service';

/** Key the boot-time permission probe writes and immediately deletes. */
const PROBE_KEY = '.obtrack-write-probe';

@Injectable()
export class S3StorageService extends StorageService implements OnModuleInit {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: AppConfigService) {
    super();
    this.bucket = this.config.s3Bucket;

    this.client = new S3Client({
      region: this.config.s3Region,
      // Set only for S3-compatible services (MinIO, Cloudflare R2, DigitalOcean
      // Spaces). Left undefined for real AWS, where the SDK derives the endpoint
      // from the region.
      ...(this.config.s3Endpoint ? { endpoint: this.config.s3Endpoint } : {}),
      // Path-style addressing (`endpoint/bucket/key` rather than
      // `bucket.endpoint/key`). AWS deprecated it; most self-hosted S3-alikes
      // require it.
      ...(this.config.s3ForcePathStyle ? { forcePathStyle: true } : {}),
      // NOTE: credentials are deliberately NOT passed.
      //
      // The SDK's default provider chain finds them itself, and on EC2 that
      // means the instance's IAM role — short-lived credentials that rotate
      // automatically and never exist as a string anywhere. Passing
      // AWS_ACCESS_KEY_ID/SECRET here would work too, but it turns a rotating
      // credential into a long-lived one sitting in .env.production, which is
      // the thing that leaks. Locally the chain falls back to ~/.aws or the
      // standard environment variables with no code change.
    });
  }

  /**
   * Proves at boot that this process can actually write to the bucket, by
   * putting a tiny object and deleting it again.
   *
   * `HeadBucket` would be the obvious check and is the wrong one: it needs
   * `s3:ListBucket`, a permission the app otherwise never uses, so a correctly
   * minimal IAM policy would fail the check and block a deployment that would
   * have worked. Put-then-delete exercises exactly the two permissions receipts
   * actually need and nothing more.
   *
   * Failing here stops the container starting, which mirrors the local-disk
   * driver: a storage backend the app cannot write to should be a visible
   * deploy failure, not a 500 the first office boy discovers.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: PROBE_KEY,
          Body: Buffer.from('ok'),
        }),
      );
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: PROBE_KEY }),
      );
    } catch (error) {
      throw new Error(
        `Cannot write to S3 bucket "${this.bucket}" in ${this.config.s3Region}. ` +
          "Check the bucket exists and that this instance's IAM role grants " +
          `s3:PutObject and s3:DeleteObject on arn:aws:s3:::${this.bucket}/*. ` +
          `Underlying error: ${(error as Error).message}`,
      );
    }

    this.logger.log(`Receipt storage ready in s3://${this.bucket}`);
  }

  async save(buffer: Buffer, options: SaveFileOptions): Promise<StoredFile> {
    const key = buildStorageKey(options.namespace, options.mimeType);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: options.mimeType,
        // Encrypt at rest. S3 does this by default on new buckets now, but
        // stating it means the object is encrypted even if the bucket default
        // is ever relaxed.
        ServerSideEncryption: 'AES256',
      }),
    );

    return { key, sizeBytes: buffer.byteLength, mimeType: options.mimeType };
  }

  /**
   * Streams an object back.
   *
   * The bytes are proxied through `GET /tasks/:id/receipt` rather than handed
   * out as a presigned URL. That keeps the bucket fully private and leaves
   * authorisation in exactly one place — the service's owner-or-admin check —
   * instead of splitting it between the app and a URL whose expiry is the only
   * thing standing between a leaked link and the file. The cost is that receipt
   * bytes traverse the API; at a few hundred KB per receipt that is not a
   * problem worth trading security for.
   */
  async createReadStream(key: string): Promise<Readable> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (!response.Body) {
        throw new NotFoundException('Receipt file is no longer available.');
      }

      // In Node the SDK returns a Readable; the union also covers the browser
      // Blob/ReadableStream shapes, which cannot occur here.
      return response.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) {
        // The row says there is a file and the bucket disagrees. Worth logging
        // as an inconsistency, but from the caller's side it is a 404.
        this.logger.warn(`Receipt missing from bucket: ${key}`);
        throw new NotFoundException('Receipt file is no longer available.');
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject is already idempotent — deleting a key that is not there
    // succeeds — which matches the contract on StorageService.delete without
    // any special handling.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }
}

/**
 * Whether an SDK error means "no such object".
 *
 * Checked two ways because S3 is not consistent about it: `GetObject` raises a
 * typed `NoSuchKey`, while `HeadObject` — having no response body to put an
 * error code in — surfaces a bare 404. Testing only one of them makes a missing
 * receipt a 500 on whichever path was not covered.
 */
function isNotFound(error: unknown): boolean {
  const err = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404
  );
}
