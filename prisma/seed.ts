/**
 * Database seed.
 *
 * ## Why a seed script exists at all
 *
 * There is a chicken-and-egg problem in every system with role-based access:
 * only an admin may create users, but the first admin has to come from
 * somewhere. Right now `POST /users` is wide open precisely because it is the
 * only way to create that first account — which is also a serious security
 * hole. This script is what lets Phase 2 close it.
 *
 * ## Idempotency
 *
 * Running this twice must be safe. Every write below is an `upsert` whose
 * `update` clause is empty — meaning "create it if missing, otherwise leave it
 * exactly as it is". Deliberately NOT resetting the password on re-run: a seed
 * that silently overwrites a changed admin password would be a very unpleasant
 * surprise in a shared environment.
 *
 * Run with:  npm run prisma:seed
 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

import { PrismaClient } from '../src/generated/prisma/client';
import { Role } from '../src/generated/prisma/enums';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const isProduction = process.env.NODE_ENV === 'production';
const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);

/** Development-only fallbacks. Never used when NODE_ENV=production. */
const DEV_DEFAULTS = {
  email: 'admin@obtrack.local',
  password: 'ChangeMe123!',
  name: 'System Administrator',
};

/**
 * Reads an environment variable, treating an empty string as "not set".
 *
 * `.env` files routinely contain `SEED_ADMIN_EMAIL=""` as a placeholder. The
 * `??` operator would NOT fall back there, because `""` is neither null nor
 * undefined — it would happily create a user with an empty email. Anything
 * reading optional config out of `process.env` needs this distinction.
 */
function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function resolveAdminCredentials() {
  const email = optionalEnv('SEED_ADMIN_EMAIL');
  const password = optionalEnv('SEED_ADMIN_PASSWORD');
  const name = optionalEnv('SEED_ADMIN_NAME');

  if (isProduction) {
    // A well-known default password in production is not a seed script; it is
    // a backdoor. Refuse rather than create one.
    if (!email || !password) {
      throw new Error(
        'SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required when NODE_ENV=production. ' +
          'Refusing to seed a default administrator account.',
      );
    }
    if (password.length < 12) {
      throw new Error(
        'SEED_ADMIN_PASSWORD must be at least 12 characters in production.',
      );
    }
  }

  return {
    email: email ?? DEV_DEFAULTS.email,
    password: password ?? DEV_DEFAULTS.password,
    name: name ?? DEV_DEFAULTS.name,
  };
}

async function seedAdmin(): Promise<void> {
  const credentials = resolveAdminCredentials();
  const existing = await prisma.user.findUnique({
    where: { email: credentials.email },
  });

  if (existing) {
    console.log(`  admin      already exists: ${credentials.email} (unchanged)`);
    return;
  }

  await prisma.user.create({
    data: {
      name: credentials.name,
      email: credentials.email,
      password: await bcrypt.hash(credentials.password, saltRounds),
      role: Role.ADMIN,
      isActive: true,
    },
  });

  console.log(`  admin      created: ${credentials.email}`);

  if (!optionalEnv('SEED_ADMIN_PASSWORD')) {
    console.log(
      `\n  ⚠  Using the development default password: ${DEV_DEFAULTS.password}` +
        `\n     Set SEED_ADMIN_PASSWORD in .env to choose your own.\n`,
    );
  }
}

/**
 * Sample office boys, for local development only.
 *
 * Seeding realistic-looking data into production is how test accounts end up
 * as real logins nobody remembers creating.
 */
async function seedSampleOfficeBoys(): Promise<void> {
  if (isProduction) {
    console.log('  officeBoys skipped (NODE_ENV=production)');
    return;
  }

  const samples = [
    { name: 'Bilal Ahmed', email: 'bilal@obtrack.local', phone: '+923001234567' },
    { name: 'Usman Tariq', email: 'usman@obtrack.local', phone: '+923009876543' },
  ];

  const password = await bcrypt.hash('Password123!', saltRounds);

  for (const sample of samples) {
    const existing = await prisma.user.findUnique({
      where: { email: sample.email },
    });

    if (existing) {
      console.log(`  officeBoy  already exists: ${sample.email} (unchanged)`);
      continue;
    }

    await prisma.user.create({
      data: { ...sample, password, role: Role.OFFICE_BOY, isActive: true },
    });
    console.log(`  officeBoy  created: ${sample.email}  (password: Password123!)`);
  }
}

async function main(): Promise<void> {
  console.log(`\nSeeding database [${process.env.NODE_ENV ?? 'development'}]\n`);

  await seedAdmin();
  await seedSampleOfficeBoys();

  const total = await prisma.user.count();
  console.log(`\nDone. ${total} user(s) in the database.\n`);
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error);
    // A non-zero exit code matters: it is how a deployment pipeline learns the
    // seed failed instead of continuing with a half-configured database.
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
