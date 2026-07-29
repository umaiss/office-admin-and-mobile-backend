import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Prisma } from '../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { ApiErrorResponseDto } from '../dto/api-response.dto';

/**
 * Numeric floor for "this is our fault, not the caller's".
 *
 * Declared as a plain `number` rather than compared against `HttpStatus`
 * directly: `normalised.status` comes from `exception.getStatus()`, which
 * returns a plain number, and TypeScript rightly objects to comparing a raw
 * number against an enum member.
 */
const SERVER_ERROR_FLOOR: number = HttpStatus.INTERNAL_SERVER_ERROR;

/** What we managed to work out about an exception, before formatting it. */
interface NormalisedError {
  status: number;
  message: string | string[];
  error: string;
  /** Detail we log but never send to the client. */
  internal?: string;
}

/**
 * The single place where any failure becomes an HTTP response.
 *
 * `@Catch()` with no arguments means "catch everything" — thrown
 * HttpExceptions, Prisma errors, and plain old bugs like `undefined is not a
 * function`. Without this filter, Nest's default handler turns anything it does
 * not recognise into a bare 500 with no logging, which is how production
 * problems become invisible.
 *
 * Two rules govern what goes where:
 *
 *   • Everything the developer needs (stack trace, Prisma error code, SQL
 *     details) goes to the LOGS.
 *   • Only what the client needs goes in the RESPONSE.
 *
 * Leaking internals to clients is a real vulnerability: error messages are how
 * attackers map your database schema and library versions.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly config: AppConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Phase 7 will add a WebSocket branch here. Until then, anything that is
    // not an HTTP request is logged and rethrown rather than silently dropped.
    if (host.getType() !== 'http') {
      this.logger.error('Non-HTTP exception', exception as Error);
      throw exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const normalised = this.normalise(exception);
    const isProduction = this.config.isProduction;

    // A 500 means *we* broke. Log it loudly, with the stack, always.
    if (normalised.status >= SERVER_ERROR_FLOOR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${normalised.status}: ${
          normalised.internal ?? String(normalised.message)
        }`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      // A 4xx means the *caller* made a mistake. Worth recording, not alarming.
      this.logger.warn(
        `${request.method} ${request.url} -> ${normalised.status}: ${String(
          normalised.message,
        )}`,
      );
    }

    const body: ApiErrorResponseDto = {
      success: false,
      statusCode: normalised.status,
      // In production a 500 must never echo the underlying message: it could
      // contain a connection string, a file path, or a column name.
      message:
        isProduction && normalised.status >= SERVER_ERROR_FLOOR
          ? 'Internal server error'
          : normalised.message,
      error: normalised.error,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    };

    response.status(normalised.status).json(body);
  }

  private normalise(exception: unknown): NormalisedError {
    // 1. Exceptions we threw on purpose (NotFoundException, etc.).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // ValidationPipe returns an object with a string[] of every failure.
      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        return {
          status,
          message: (record.message ?? exception.message) as string | string[],
          error: (record.error as string) ?? exception.name,
        };
      }

      return { status, message: String(payload), error: exception.name };
    }

    // 2. Database errors Prisma recognised and gave us a code for.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    // 3. A malformed query we built. Always our bug, never the client's.
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
        error: 'Internal Server Error',
        internal: exception.message,
      };
    }

    // 4. Anything else: an unhandled bug.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      internal:
        exception instanceof Error ? exception.message : String(exception),
    };
  }

  /**
   * Translates Prisma's error codes into the HTTP status a client expects.
   *
   * Without this, a duplicate email would surface as a 500 ("something broke")
   * when the truth is a 409 ("that email is taken") — a message the client can
   * actually act on.
   *
   * Full code reference: https://www.prisma.io/docs/orm/reference/error-reference
   */
  private fromPrisma(
    exception: Prisma.PrismaClientKnownRequestError,
  ): NormalisedError {
    const internal = `Prisma ${exception.code}: ${exception.message}`;

    switch (exception.code) {
      case 'P2002': {
        // Unique constraint violated. `meta.target` names the offending field(s).
        const target = exception.meta?.target;
        const fields = Array.isArray(target)
          ? target.join(', ')
          : typeof target === 'string'
            ? target
            : 'field';
        return {
          status: HttpStatus.CONFLICT,
          message: `A record with this ${fields} already exists.`,
          error: 'Conflict',
          internal,
        };
      }

      case 'P2025':
        // Tried to update/delete a row that is not there.
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'The requested record was not found.',
          error: 'Not Found',
          internal,
        };

      case 'P2003':
        // Foreign key constraint — pointing at something that does not exist.
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A referenced record does not exist.',
          error: 'Bad Request',
          internal,
        };

      case 'P2000':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A provided value is too long for its field.',
          error: 'Bad Request',
          internal,
        };

      case 'P2014':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'This change would break a required relation.',
          error: 'Bad Request',
          internal,
        };

      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
          error: 'Internal Server Error',
          internal,
        };
    }
  }
}
