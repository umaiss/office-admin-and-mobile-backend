import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NotFoundException } from '@nestjs/common';

import type { AppConfigService } from '../config/app-config.service';
import { LocalDiskStorageService } from './local-disk.storage';

/**
 * Unlike the rest of the suite this touches a real filesystem, in a throwaway
 * temp directory. The behaviour under test IS filesystem behaviour — that a key
 * cannot escape the uploads root, that a replaced file really goes away — and
 * mocking `fs` would only assert that the mock was called, not that the escape
 * was actually prevented.
 */
describe('LocalDiskStorageService', () => {
  let root: string;
  let service: LocalDiskStorageService;

  const config = (uploadsDir: string) =>
    ({ uploadsDir, maxReceiptBytes: 5_242_880 }) as AppConfigService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'obtrack-storage-'));
    service = new LocalDiskStorageService(config(root));
    await service.onModuleInit();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('onModuleInit', () => {
    it('creates the root directory when it does not exist yet', async () => {
      const fresh = path.join(root, 'nested', 'deeper');
      const service = new LocalDiskStorageService(config(fresh));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('refuses to start when the root exists but is not writable', async () => {
      // The Docker case this guards: a named volume mounted at a path the image
      // never created is owned by root, while the container runs as `node`.
      // `mkdir(recursive)` succeeds on an existing directory, so only an
      // explicit write check catches it — and catching it at boot turns a 500
      // on an office boy's first upload into a deploy that visibly fails.
      const readOnly = path.join(root, 'locked');
      await mkdir(readOnly);
      await chmod(readOnly, 0o500);

      const service = new LocalDiskStorageService(config(readOnly));

      let threw = false;
      try {
        await service.onModuleInit();
      } catch (error) {
        threw = true;
        expect((error as Error).message).toMatch(/not writable/);
      } finally {
        await chmod(readOnly, 0o700);
      }

      // Windows ignores POSIX permission bits, so the directory stays writable
      // there and the check correctly passes. Assert the behaviour only where
      // the operating system can actually express it.
      if (process.platform !== 'win32') {
        expect(threw).toBe(true);
      }
    });
  });

  describe('save', () => {
    it('writes the bytes and returns a server-generated key', async () => {
      const bytes = Buffer.from('receipt bytes');

      const stored = await service.save(bytes, {
        mimeType: 'image/jpeg',
        originalName: 'my photo.jpg',
        namespace: 'receipts',
      });

      expect(stored.sizeBytes).toBe(bytes.byteLength);
      expect(stored.mimeType).toBe('image/jpeg');
      // Date-sharded under the namespace, extension from the VERIFIED type.
      expect(stored.key).toMatch(
        /^receipts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/,
      );
      await expect(readFile(path.join(root, stored.key))).resolves.toEqual(
        bytes,
      );
    });

    it('never lets the client filename influence the path', async () => {
      const stored = await service.save(Buffer.from('x'), {
        mimeType: 'image/png',
        // A filename is attacker-controlled text; if it reached path.join, this
        // would write outside the uploads root entirely.
        originalName: '../../../../etc/passwd',
        namespace: 'receipts',
      });

      expect(stored.key).not.toContain('..');
      expect(stored.key).not.toContain('passwd');
      expect(path.resolve(root, stored.key).startsWith(root)).toBe(true);
    });
  });

  describe('path fencing', () => {
    it.each([
      '../outside.jpg',
      'receipts/../../outside.jpg',
      '../../../../../../etc/passwd',
    ])('refuses to read a key that escapes the root: %s', async (key) => {
      // Put a real file where the traversal would land, so a pass would be a
      // genuine arbitrary-file read rather than merely a missing file.
      await writeFile(path.join(path.dirname(root), 'outside.jpg'), 'secret');

      await expect(service.createReadStream(key)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      await rm(path.join(path.dirname(root), 'outside.jpg'), { force: true });
    });

    it('refuses a sibling directory that merely shares the root prefix', async () => {
      // `/tmp/obtrack-storage-x` must not accept `/tmp/obtrack-storage-x-evil`.
      const evil = `${path.basename(root)}-evil/file.jpg`;

      await expect(service.exists(`../${evil}`)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('createReadStream', () => {
    it('streams back exactly what was written', async () => {
      const bytes = Buffer.from('hello receipt');
      const stored = await service.save(bytes, {
        mimeType: 'application/pdf',
        originalName: 'r.pdf',
        namespace: 'receipts',
      });

      const stream = await service.createReadStream(stored.key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }

      expect(Buffer.concat(chunks)).toEqual(bytes);
    });

    it('404s for a key whose file is gone — a row pointing at nothing', async () => {
      await expect(
        service.createReadStream('receipts/2026/08/missing.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('removes the file', async () => {
      const stored = await service.save(Buffer.from('x'), {
        mimeType: 'image/jpeg',
        originalName: 'r.jpg',
        namespace: 'receipts',
      });

      await service.delete(stored.key);

      await expect(service.exists(stored.key)).resolves.toBe(false);
    });

    it('treats an already-missing file as success', async () => {
      // Deletes run as cleanup after the authoritative row is already gone;
      // erroring here would fail a request that achieved what it asked for.
      await expect(
        service.delete('receipts/2026/08/never-existed.jpg'),
      ).resolves.toBeUndefined();
    });
  });
});
