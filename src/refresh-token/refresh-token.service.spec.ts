import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';

interface Row {
  id: string;
  hashedToken: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * An in-memory stand-in for the refreshToken table.
 *
 * Using a fake rather than a `jest.fn()` per method is deliberate: rotation is
 * *stateful* — revoke this row, create that one, then detect that the first is
 * being replayed. What matters here is the resulting state, and per-call mocks
 * cannot express that.
 */
class FakeRefreshTokenTable {
  rows = new Map<string, Row>();
  private counter = 0;

  create({ data }: { data: Record<string, any> }) {
    const id = `token-${++this.counter}`;
    const row: Row = {
      id,
      hashedToken: data.hashedToken as string,
      userId: data.userId as string,
      expiresAt: data.expiresAt as Date,
      revokedAt: null,
      replacedByTokenId: null,
      userAgent: (data.userAgent as string) ?? null,
      ipAddress: (data.ipAddress as string) ?? null,
    };
    this.rows.set(id, row);
    return Promise.resolve({ ...row });
  }

  findUnique({ where }: { where: { id: string } }) {
    const row = this.rows.get(where.id);
    return Promise.resolve(row ? { ...row } : null);
  }

  update({
    where,
    data,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
  }) {
    const row = this.rows.get(where.id);
    if (row) Object.assign(row, data);
    return Promise.resolve(row ? { ...row } : null);
  }

  updateMany({
    where,
    data,
  }: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) {
    let count = 0;
    for (const row of this.rows.values()) {
      if (where.id !== undefined && row.id !== where.id) continue;
      if (where.userId !== undefined && row.userId !== where.userId) continue;
      if (where.revokedAt === null && row.revokedAt !== null) continue;
      Object.assign(row, data);
      count++;
    }
    return Promise.resolve({ count });
  }

  deleteMany() {
    return Promise.resolve({ count: 0 });
  }
}

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;
  let table: FakeRefreshTokenTable;

  const TTL = 2592000; // 30 days

  beforeEach(async () => {
    table = new FakeRefreshTokenTable();

    const prisma = {
      refreshToken: table,
      // The unit test does not need real atomicity — only that the callback
      // runs against the same fake table.
      $transaction: (fn: (tx: unknown) => unknown) =>
        Promise.resolve(fn({ refreshToken: table })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(RefreshTokenService);
  });

  describe('issue', () => {
    it('returns a token shaped as <rowId>.<secret>', async () => {
      const { token } = await service.issue('user-1', TTL);
      const [id, secret] = token.split('.');

      expect(table.rows.has(id)).toBe(true);
      expect(secret.length).toBeGreaterThan(20);
    });

    it('never stores the raw secret', async () => {
      const { token } = await service.issue('user-1', TTL);
      const [id, secret] = token.split('.');

      // If the database leaks, the tokens in it must not be usable.
      const stored = table.rows.get(id)!.hashedToken;
      expect(stored).not.toBe(secret);
      expect(stored).toBe(createHash('sha256').update(secret).digest('hex'));
    });

    it('records the device context', async () => {
      const { token } = await service.issue('user-1', TTL, {
        userAgent: 'OBTrack/1.0',
        ipAddress: '203.0.113.7',
      });

      const row = table.rows.get(token.split('.')[0])!;
      expect(row.userAgent).toBe('OBTrack/1.0');
      expect(row.ipAddress).toBe('203.0.113.7');
    });
  });

  describe('rotate', () => {
    it('issues a new token and revokes the old one', async () => {
      const { token } = await service.issue('user-1', TTL);
      const oldId = token.split('.')[0];

      const result = await service.rotate(token, TTL);

      expect(result.ok).toBe(true);
      const oldRow = table.rows.get(oldId)!;
      expect(oldRow.revokedAt).not.toBeNull();
      if (result.ok) {
        expect(oldRow.replacedByTokenId).toBe(result.token.split('.')[0]);
      }
    });

    it('rejects a malformed token', async () => {
      expect(await service.rotate('no-separator-here', TTL)).toEqual({
        ok: false,
        reason: 'MALFORMED',
      });
    });

    it('rejects an unknown token id', async () => {
      expect(await service.rotate('token-999.somesecret', TTL)).toEqual({
        ok: false,
        reason: 'NOT_FOUND',
      });
    });

    it('rejects a valid id paired with the wrong secret', async () => {
      const { token } = await service.issue('user-1', TTL);
      const id = token.split('.')[0];

      expect(await service.rotate(`${id}.wrongsecret`, TTL)).toEqual({
        ok: false,
        reason: 'INVALID_SECRET',
      });
    });

    it('rejects an expired token', async () => {
      const { token } = await service.issue('user-1', TTL);
      table.rows.get(token.split('.')[0])!.expiresAt = new Date(
        Date.now() - 1000,
      );

      expect(await service.rotate(token, TTL)).toEqual({
        ok: false,
        reason: 'EXPIRED',
      });
    });

    it('detects reuse and revokes every session for that user', async () => {
      // The scenario: a token is stolen. The legitimate user refreshes, which
      // rotates their token. The thief then replays the old one.
      const { token } = await service.issue('user-1', TTL);
      const otherDevice = await service.issue('user-1', TTL);

      await service.rotate(token, TTL); // legitimate refresh
      const replay = await service.rotate(token, TTL); // thief replays

      expect(replay).toEqual({ ok: false, reason: 'REUSED' });

      // Because victim and thief are indistinguishable, EVERY session must die
      // — including the user's other device.
      const live = [...table.rows.values()].filter((r) => r.revokedAt === null);
      expect(live).toHaveLength(0);
      expect(
        table.rows.get(otherDevice.token.split('.')[0])!.revokedAt,
      ).not.toBeNull();
    });

    it('does not treat a logged-out token as theft', async () => {
      // Regression test for a bug found in live testing. Logout and rotation
      // both set `revokedAt`, so an app retrying a refresh once after logout
      // was being classified as a thief — and signed out of every device.
      // Only a token superseded by ROTATION (replacedByTokenId set) is reuse.
      const phone = await service.issue('user-1', TTL);
      const dashboard = await service.issue('user-1', TTL);

      await service.revoke(phone.token);
      const result = await service.rotate(phone.token, TTL);

      expect(result).toEqual({ ok: false, reason: 'REVOKED' });

      // The other device must still be usable.
      expect(
        table.rows.get(dashboard.token.split('.')[0])!.revokedAt,
      ).toBeNull();
      expect((await service.rotate(dashboard.token, TTL)).ok).toBe(true);
    });

    it('does not treat a wrong secret on a revoked row as reuse', async () => {
      // Otherwise anyone who learned a token id — from a log file, say — could
      // force a logout for that user, turning a security feature into a
      // denial-of-service lever.
      const { token } = await service.issue('user-1', TTL);
      const id = token.split('.')[0];
      await service.rotate(token, TTL);

      expect(await service.rotate(`${id}.wrongsecret`, TTL)).toEqual({
        ok: false,
        reason: 'INVALID_SECRET',
      });
    });
  });

  describe('revoke', () => {
    it('revokes one device without touching the others', async () => {
      const phone = await service.issue('user-1', TTL);
      const dashboard = await service.issue('user-1', TTL);

      await service.revoke(phone.token);

      expect(
        table.rows.get(phone.token.split('.')[0])!.revokedAt,
      ).not.toBeNull();
      expect(
        table.rows.get(dashboard.token.split('.')[0])!.revokedAt,
      ).toBeNull();
    });

    it('is silent about an unknown token', async () => {
      await expect(service.revoke('token-999.secret')).resolves.toBeUndefined();
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes that user only', async () => {
      const mine = await service.issue('user-1', TTL);
      const theirs = await service.issue('user-2', TTL);

      await service.revokeAllForUser('user-1');

      expect(
        table.rows.get(mine.token.split('.')[0])!.revokedAt,
      ).not.toBeNull();
      expect(table.rows.get(theirs.token.split('.')[0])!.revokedAt).toBeNull();
    });
  });
});
