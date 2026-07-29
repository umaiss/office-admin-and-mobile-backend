import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

/** Context captured with each token so a user can log out one device. */
export interface TokenContext {
  userAgent?: string;
  ipAddress?: string;
}

/** Why a refresh attempt failed. The caller turns this into an HTTP response. */
export type RefreshFailure =
  | 'MALFORMED'
  | 'NOT_FOUND'
  | 'EXPIRED'
  /** Deliberately ended — logout or admin action. Not suspicious. */
  | 'REVOKED'
  /** Superseded by rotation, yet presented again. Treated as theft. */
  | 'REUSED'
  | 'INVALID_SECRET';

export type RefreshResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; reason: RefreshFailure };

/**
 * Issues, validates, and rotates refresh tokens.
 *
 * ## The token format: `<rowId>.<secret>`
 *
 * The previous implementation stored only a bcrypt hash, so validating a token
 * meant loading every token row for that user and bcrypt-comparing against each
 * one. At ~250ms per comparison, a user who had logged in 200 times paid many
 * seconds per refresh — and it got permanently worse with every login.
 *
 * Embedding the row id in the token turns that into a single primary-key lookup
 * followed by exactly one hash comparison. O(n) becomes O(1).
 *
 * ## Why SHA-256 here, but bcrypt for passwords
 *
 * bcrypt is deliberately slow, which is what protects a *low-entropy* secret: a
 * human password is guessable, so each guess must be made expensive.
 *
 * This secret is 32 bytes from a cryptographically secure random source — 256
 * bits of entropy. There is no dictionary to try and no feasible brute force,
 * so slowness buys nothing and costs latency on every refresh. A fast
 * cryptographic hash is the correct tool, and it is what token implementations
 * generally use.
 *
 * Matching the hash to the secret's entropy — rather than reaching for bcrypt
 * reflexively — is the actual lesson here.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** SHA-256, hex encoded. Deterministic, so it can be stored and compared. */
  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /**
   * Compares two hashes without leaking timing information.
   *
   * A naive `a === b` returns as soon as it finds a differing byte, so how long
   * it takes reveals how many leading characters were correct. That can be
   * exploited to recover a secret one character at a time. `timingSafeEqual`
   * always takes the same time regardless of where the difference lies.
   */
  private matches(candidate: string, stored: string): boolean {
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(stored, 'hex');
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }

  /** Creates a token row and returns the plaintext token for the client. */
  async issue(
    userId: string,
    ttlSeconds: number,
    context: TokenContext = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const row = await this.prisma.refreshToken.create({
      data: {
        hashedToken: this.hash(secret),
        expiresAt,
        userId,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      },
      select: { id: true },
    });

    // `.` is a safe delimiter: base64url never produces one, and a UUID
    // contains only hex digits and hyphens.
    return { token: `${row.id}.${secret}`, expiresAt };
  }

  /**
   * Validates a refresh token and rotates it.
   *
   * ## Rotation
   *
   * Every successful refresh issues a NEW refresh token and revokes the old
   * one. Without rotation, a token stolen once keeps working for its whole
   * lifetime — which, at a 30-day TTL, is a very long time to be compromised.
   *
   * ## Reuse detection
   *
   * Revoked rows are marked, not deleted, so a token presented a second time
   * can still be recognised. If an already-revoked token arrives with the
   * correct secret, two parties hold it: the legitimate user and a thief. There
   * is no way to tell which one is calling, so the only safe response is to
   * revoke every session for that user and force a fresh login.
   *
   * This is what turns rotation from a minor improvement into a genuine
   * detection mechanism — theft becomes visible rather than silent.
   */
  async rotate(
    presentedToken: string,
    ttlSeconds: number,
    context: TokenContext = {},
  ): Promise<RefreshResult> {
    const separator = presentedToken.indexOf('.');
    if (separator <= 0) {
      return { ok: false, reason: 'MALFORMED' };
    }

    const tokenId = presentedToken.slice(0, separator);
    const secret = presentedToken.slice(separator + 1);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { id: tokenId },
    });

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    // Verify the secret BEFORE treating a revoked row as theft. Otherwise
    // anyone who learned a token id — from a log file, say — could force a
    // logout for that user just by guessing. Requiring proof of possession
    // first makes reuse detection meaningful instead of a denial-of-service
    // lever.
    if (!this.matches(this.hash(secret), existing.hashedToken)) {
      return { ok: false, reason: 'INVALID_SECRET' };
    }

    if (existing.revokedAt) {
      // Not every revoked token is a stolen one, and conflating the two is a
      // real bug: logging out also sets `revokedAt`, so a mobile app whose
      // background sync retries a refresh once after logout would be treated as
      // a thief and signed out of every device it owns.
      //
      // `replacedByTokenId` is the discriminator. It is set only by rotation,
      // so:
      //   • revoked WITH a replacement  → this token was superseded, yet someone
      //     still holds a working copy. Two parties have it. Theft.
      //   • revoked WITHOUT a replacement → an explicit logout or an admin
      //     revocation. Simply refuse it; nothing suspicious happened.
      if (!existing.replacedByTokenId) {
        return { ok: false, reason: 'REVOKED' };
      }

      this.logger.warn(
        `Refresh token reuse detected for user ${existing.userId}; revoking all sessions`,
      );
      await this.revokeAllForUser(existing.userId);
      return { ok: false, reason: 'REUSED' };
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'EXPIRED' };
    }

    const nextSecret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Both writes must happen together. If the new token were created but the
    // old one never revoked, the old token would stay valid — exactly the hole
    // rotation exists to close.
    const created = await this.prisma.$transaction(async (tx) => {
      const next = await tx.refreshToken.create({
        data: {
          hashedToken: this.hash(nextSecret),
          expiresAt,
          userId: existing.userId,
          userAgent: context.userAgent ?? existing.userAgent,
          ipAddress: context.ipAddress ?? existing.ipAddress,
        },
        select: { id: true },
      });

      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedByTokenId: next.id },
      });

      return next;
    });

    return {
      ok: true,
      userId: existing.userId,
      token: `${created.id}.${nextSecret}`,
      expiresAt,
    };
  }

  /**
   * Revokes a single token — "log out this device".
   *
   * The old implementation deleted every token for the user, so logging out on
   * a phone also logged the user out of the admin dashboard. Sessions are
   * per-device; logout should be too.
   */
  async revoke(presentedToken: string): Promise<void> {
    const separator = presentedToken.indexOf('.');
    if (separator <= 0) {
      return;
    }

    const tokenId = presentedToken.slice(0, separator);

    // updateMany rather than update: it does not throw when the row is absent,
    // and logging out with an already-invalid token should quietly succeed
    // rather than fail.
    await this.prisma.refreshToken.updateMany({
      where: { id: tokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every session for a user — password change, or theft detected. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Deletes rows that are expired or long revoked.
   *
   * Revoked rows must be kept for a while — they are what makes reuse detection
   * possible — but not forever. Phase 10 will run this on a schedule.
   */
  async purgeStale(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });

    return count;
  }
}
