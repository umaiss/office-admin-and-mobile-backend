import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { NotFoundException } from '@nestjs/common';

import type { AppConfigService } from '../config/app-config.service';
import { S3StorageService } from './s3.storage';

/**
 * The SDK client is stubbed rather than talking to a real bucket: what is worth
 * pinning here is the mapping between S3's behaviour and this app's contract —
 * that a missing object becomes a 404 rather than a 500, that keys match the
 * local driver's scheme, and that the boot probe proves write access using only
 * the permissions a minimal IAM policy grants.
 */
describe('S3StorageService', () => {
  let service: S3StorageService;
  let send: jest.Mock;

  const config = {
    s3Bucket: 'obtrack-receipts',
    s3Region: 'eu-north-1',
    s3Endpoint: undefined,
    s3ForcePathStyle: false,
  } as AppConfigService;

  /** The command instance passed to the nth `client.send` call. */
  const sentCommand = (index: number): unknown => {
    const call = send.mock.calls[index] as unknown[];
    return call[0];
  };

  /** The `input` of the nth sent command, as a plain record. */
  const sentInput = (index: number): Record<string, unknown> =>
    (sentCommand(index) as { input: Record<string, unknown> }).input;

  /** An SDK-shaped error, which is how the real client reports a miss. */
  const notFound = (name: string, status = 404) =>
    Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: status },
    });

  beforeEach(() => {
    send = jest.fn().mockResolvedValue({});
    service = new S3StorageService(config);
    // The client is constructed in the constructor; swap its transport.
    (service as unknown as { client: { send: jest.Mock } }).client = { send };
  });

  describe('onModuleInit', () => {
    it('proves write access with a put-then-delete probe', async () => {
      await service.onModuleInit();

      // NOT HeadBucket: that needs s3:ListBucket, which the app never otherwise
      // uses, so a correctly minimal IAM policy would fail a check for it and
      // block a deploy that would have worked.
      expect(sentCommand(0)).toBeInstanceOf(PutObjectCommand);
      expect(sentCommand(1)).toBeInstanceOf(DeleteObjectCommand);
      expect(sentInput(0).Bucket).toBe('obtrack-receipts');
      expect(sentInput(0).Key).toBe(sentInput(1).Key);
    });

    it('refuses to start, naming the bucket and permissions, when the probe fails', async () => {
      send.mockRejectedValue(new Error('AccessDenied'));

      await expect(service.onModuleInit()).rejects.toThrow(
        /obtrack-receipts.*s3:PutObject/s,
      );
    });
  });

  describe('save', () => {
    it('stores under the shared key scheme with the verified content type', async () => {
      const bytes = Buffer.from('receipt bytes');

      const stored = await service.save(bytes, {
        mimeType: 'image/jpeg',
        originalName: '../../etc/passwd',
        namespace: 'receipts',
      });

      // Identical to the local driver's keys, so switching backends does not
      // strand the storageKey values already in the database.
      expect(stored.key).toMatch(
        /^receipts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/,
      );
      expect(stored.sizeBytes).toBe(bytes.byteLength);

      const input = sentInput(0);
      expect(sentCommand(0)).toBeInstanceOf(PutObjectCommand);
      expect(input.ContentType).toBe('image/jpeg');
      expect(input.ServerSideEncryption).toBe('AES256');
      // The client's filename never reaches the key.
      expect(String(input.Key)).not.toContain('passwd');
    });
  });

  describe('createReadStream', () => {
    it('returns the object body', async () => {
      const body = Readable.from([Buffer.from('hello')]);
      send.mockResolvedValue({ Body: body });

      await expect(
        service.createReadStream('receipts/2026/08/x.jpg'),
      ).resolves.toBe(body);
      expect(sentCommand(0)).toBeInstanceOf(GetObjectCommand);
    });

    it('turns a NoSuchKey into a 404, not a 500', async () => {
      send.mockRejectedValue(notFound('NoSuchKey'));

      await expect(
        service.createReadStream('receipts/2026/08/gone.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the object exists but has no body', async () => {
      send.mockResolvedValue({ Body: undefined });

      await expect(
        service.createReadStream('receipts/2026/08/empty.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rethrows a genuine failure rather than disguising it as missing', async () => {
      // An expired credential is not a missing receipt, and reporting it as one
      // would send someone hunting for a lost file instead of fixing IAM.
      send.mockRejectedValue(
        Object.assign(new Error('ExpiredToken'), {
          name: 'ExpiredToken',
          $metadata: { httpStatusCode: 403 },
        }),
      );

      await expect(
        service.createReadStream('receipts/2026/08/x.jpg'),
      ).rejects.toThrow('ExpiredToken');
    });
  });

  describe('exists', () => {
    it('is true when HeadObject succeeds', async () => {
      await expect(service.exists('receipts/2026/08/x.jpg')).resolves.toBe(
        true,
      );
      expect(sentCommand(0)).toBeInstanceOf(HeadObjectCommand);
    });

    it('is false on a bare 404 — HeadObject has no body to carry NoSuchKey', async () => {
      send.mockRejectedValue(notFound('NotFound'));

      await expect(service.exists('receipts/2026/08/gone.jpg')).resolves.toBe(
        false,
      );
    });
  });

  describe('delete', () => {
    it('issues a DeleteObject, which S3 already treats as idempotent', async () => {
      await service.delete('receipts/2026/08/x.jpg');

      expect(sentCommand(0)).toBeInstanceOf(DeleteObjectCommand);
      expect(sentInput(0).Key).toBe('receipts/2026/08/x.jpg');
    });
  });
});
