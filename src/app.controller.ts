import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from './auth/decorators/public.decorator';
import { AppService } from './app.service';

@ApiTags('App')
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
@Controller({ version: '1' })
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'API root — confirms the service is reachable' })
  getHello(): string {
    return this.appService.getHello();
  }
}
