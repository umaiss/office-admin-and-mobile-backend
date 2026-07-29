import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Authentication guard, registered globally in AppModule.
 *
 * Because it is global, the default for every route in the application is
 * "requires a valid access token". Routes opt out explicitly with `@Public()`.
 *
 * See `public.decorator.ts` for why the default is deny rather than allow.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
