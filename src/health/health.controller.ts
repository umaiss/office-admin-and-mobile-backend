import {
  Controller,
  Get,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Health probes for deployment platforms (Docker, Kubernetes, Railway, Render).
 *
 * There are deliberately TWO endpoints, because the platform asks two different
 * questions and reacts very differently to each answer:
 *
 *   • LIVENESS  — "is this process alive?"  A failure means RESTART ME.
 *   • READINESS — "can it serve traffic?"   A failure means STOP SENDING ME
 *                                            REQUESTS (but do not restart).
 *
 * Getting this wrong is a classic outage. If liveness checked the database and
 * the database briefly went down, the platform would restart every API instance
 * — turning a short database blip into a full outage, because now nothing is
 * running either. Liveness must therefore check *only* the process itself.
 */
@ApiTags('Health')
// VERSION_NEUTRAL plus the `exclude` in setGlobalPrefix keeps these at the bare
// paths /health/live and /health/ready. Probes are infrastructure, not part of
// the public API contract, so they must not move when the API version changes.
// Probes must be reachable without credentials — a load balancer has no token,
// and a health check that returns 401 reads as "this instance is broken".
@Public()
/**
 * Opts out of the `auth` throttler.
 *
 * Every throttler declared in `ThrottlerModule.forRoot` applies to EVERY route
 * — a named throttler is not opt-in, and `@Throttle({ auth: {} })` on the login
 * routes overrides that throttler's options rather than enabling it. Without
 * this, the 5-requests-per-minute limit meant to slow password guessing was
 * silently capping the whole API, so a single dashboard load 429'd.
 */
@SkipThrottle({ auth: true })
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @NoEnvelope()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 whenever the process is running. Checks no dependencies on purpose.',
  })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('ready')
  @NoEnvelope()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Returns 200 only when the database is reachable; 503 otherwise.',
  })
  async ready() {
    try {
      await this.prisma.ping();
    } catch {
      // 503 tells the load balancer to route around this instance until it
      // recovers, instead of sending users into a failing request.
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unreachable',
      });
    }

    return { status: 'ok', database: 'ok' };
  }
}
