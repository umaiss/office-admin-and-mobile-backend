import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

import { ApiSuccessResponseDto } from '../dto/api-response.dto';

/**
 * Marker used by `@NoEnvelope()` to opt an endpoint out of wrapping.
 * Needed for things like the health check, which monitoring tools expect to be
 * a flat object.
 */
export const NO_ENVELOPE_KEY = 'noEnvelope';

/**
 * Wraps every successful controller return value in the standard envelope.
 *
 * This is an *interceptor* rather than something each controller does, because
 * response shaping is a cross-cutting concern: it applies to all 40+ endpoints
 * we will eventually have. Writing it once here means no controller can forget
 * it, and changing the envelope later is a one-file change.
 *
 * Interceptors sit on both sides of the handler. We only use the "after" side,
 * via RxJS `map`, which transforms the value the handler returned.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponseDto<T> | T
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponseDto<T> | T> {
    const handler = context.getHandler();
    const controller = context.getClass();

    const optedOut =
      Reflect.getMetadata(NO_ENVELOPE_KEY, handler) === true ||
      Reflect.getMetadata(NO_ENVELOPE_KEY, controller) === true;

    if (optedOut) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
