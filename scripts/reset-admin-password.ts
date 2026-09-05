/**
 * Last-resort password recovery, run on the server.
 *
 * ## Why this exists
 *
 * Every other way back into a locked-out account needs an account you can
 * already get into:
 *
 *   - `POST /users/:id/reset-password` is `@Roles(ADMIN)`, so it needs another
 *     admin to be signed in.
 *   - The seed deliberately refuses to touch an existing admin's password, and
 *     it is right to: a seed that silently overwrote credentials in a shared
 *     environment would be a nasty surprise.
 *
 * With a single administrator — which is how this deployment is set up — that
 * leaves no recovery path at all. One forgotten password and the ledger is
 * unreachable by anyone, permanently.
 *
 * This closes that hole at the only authorisation level that makes sense for
 * account recovery of last resort: shell access to the server and the database
 * credentials. It is deliberately not reachable over the network.
 *
 * ## Usage
 *
 *   npm run admin:reset-password -- --email admin@example.com
 *   npm run admin:reset-password -- --email admin@example.com --list
 *
 * The new password is generated here rather than accepted as an argument, so
 * it never lands in shell history or a process listing. It is printed once.
 */
import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

import { PrismaClient } from '../src/generated/prisma/client';
import { Role } from '../src/generated/prisma/enums';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);

/**
 * A password that satisfies the API's own rule — at least 8 characters with an
 * uppercase letter, a lowercase letter and a digit — and has enough entropy
 * that it is safe to read out over the phone once and then change.
 */
function generatePassword(): string {
  const body = randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
  return `Ob${body}7`;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function listAdmins(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: Role.ADMIN },
    select: { email: true, name: true, isActive: true, lastLoginAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nAdministrators (${admins.length}):`);
  for (const admin of admins) {
    const seen = admin.lastLoginAt
      ? admin.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ')
      : 'never';
    console.log(
      `  ${admin.email}  ${admin.name}  active=${admin.isActive}  last login ${seen}`,
    );
  }

  if (admins.length === 1) {
    console.log(
      '\n  Note: this deployment has a single administrator. If that password is\n' +
        '  lost, this script is the only way back in — so keep server access to it.',
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    await listAdmins();
    return;
  }

  const email = readFlag('email');
  if (!email) {
    console.error(
      'Usage: npm run admin:reset-password -- --email <address>\n' +
        '       npm run admin:reset-password -- --list',
    );
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });

  if (!user) {
    console.error(`No account with the email ${email}.`);
    await listAdmins();
    process.exitCode = 1;
    return;
  }

  const password = generatePassword();

  await prisma.user.update({
    where: { id: user.id },
    data: { password: await bcrypt.hash(password, saltRounds) },
  });

  // Same as the API's reset: whoever holds a live session on this account
  // loses it. A recovery that left existing sessions running would not be one.
  const revoked = await prisma.refreshToken.deleteMany({
    where: { userId: user.id },
  });

  // A deactivated account cannot sign in however good the password is, so
  // recovering one means reactivating it too.
  if (!user.isActive) {
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
    console.log('\n  The account was deactivated — reactivated so it can sign in.');
  }

  console.log(`\n  Password reset for ${user.name} <${user.email}> (${user.role})`);
  console.log(`  Sessions revoked: ${revoked.count}`);
  console.log(`\n  New password:  ${password}\n`);
  console.log('  Shown once. Sign in and change it from Users & roles.\n');
}

main()
  .catch((error: unknown) => {
    console.error('Reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
