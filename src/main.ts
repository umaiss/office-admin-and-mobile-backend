import {
  Logger as NestLogger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { setupSwagger } from './common/swagger/setup-swagger';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Hold log lines until our pino logger is attached a few lines below, so
    // nothing from startup is lost or printed in the wrong format.
    bufferLogs: true,
  });

  // Replace Nest's built-in logger with pino everywhere, including inside
  // framework internals. From here on, `new Logger(X)` writes structured JSON.
  app.useLogger(app.get(Logger));

  // Because `validateEnv` already ran during module construction, every value
  // read here is guaranteed to exist and to be the right type — no `!`, no
  // undefined checks, no defensive fallbacks.
  const config = app.get(AppConfigService);

  // --- Reverse proxy -------------------------------------------------------
  // Must be set BEFORE any middleware that reads the client IP, so that
  // `request.ip` is the real caller rather than the proxy. Without it, behind
  // nginx every request looks like it came from 127.0.0.1: rate limiting would
  // treat all users as a single client and lock everyone out together.
  if (config.trustProxyHops > 0) {
    app.set('trust proxy', config.trustProxyHops);
  }

  // --- Security headers ----------------------------------------------------
  // helmet sets a dozen HTTP headers that turn off risky browser behaviour
  // (clickjacking via iframes, MIME-type sniffing, referrer leakage). One line,
  // and a whole category of browser-side attack becomes much harder.
  app.use(
    helmet({
      // The Swagger UI page loads inline styles and scripts, which a strict
      // Content-Security-Policy blocks. The API itself returns JSON, which a
      // CSP does not protect, so relaxing it only where docs are served is safe.
      contentSecurityPolicy: config.isProduction,
    }),
  );

  // gzip responses. Location history and report payloads are highly repetitive
  // JSON and compress by roughly 80% — a real saving on a mobile data plan.
  app.use(compression());

  // --- CORS ----------------------------------------------------------------
  // Browsers refuse cross-origin requests unless the server opts in. The React
  // dashboard runs on a different origin from this API, so it needs to be
  // listed. The React Native app is NOT a browser and ignores CORS entirely.
  //
  // Never use `origin: true` (reflect any origin) together with credentials —
  // that lets any website on the internet make authenticated calls on behalf of
  // a logged-in user.
  const corsOrigins = config.corsOrigins;

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    // A cross-origin response hides every header except a short safelist, so
    // without this the dashboard could not read the filename off an export
    // download, nor see the truncation warning the server takes care to set.
    // `allowedHeaders` is the wrong knob for that — it governs the REQUEST.
    exposedHeaders: ['Content-Disposition', 'X-Export-Truncated'],
    credentials: true,
    maxAge: 86400,
  });

  // --- Routing -------------------------------------------------------------
  // Every route is served under /api/v1/... . Versioning in the URL means that
  // when a future change would break the mobile app, we can publish /api/v2
  // alongside v1 and let old app versions keep working until users update.
  // Retrofitting versioning after clients ship is close to impossible.
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // --- Validation ----------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip any property not declared on the DTO. Stops a caller sending
      // `{"role":"ADMIN"}` to an endpoint that never meant to accept it.
      whitelist: true,
      // Go further: reject the request outright rather than silently dropping
      // the extra field, so client bugs surface loudly instead of appearing to
      // succeed.
      forbidNonWhitelisted: true,
      // Turn the plain JSON body into a real instance of the DTO class, and
      // convert "5" to 5 for params typed as number.
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Do not echo the rejected value back in the error message; a failed
      // password validation would otherwise put the password in the response.
      disableErrorMessages: false,
      validationError: { target: false, value: false },
    }),
  );

  // --- Docs ----------------------------------------------------------------
  if (config.swaggerEnabled) {
    setupSwagger(app);
  }

  // --- Graceful shutdown ---------------------------------------------------
  // Lets Nest hear SIGTERM (what Docker/Kubernetes send on deploy) and run
  // every module's onModuleDestroy — closing the database pool cleanly instead
  // of having in-flight requests killed mid-query.
  app.enableShutdownHooks();

  await app.listen(config.port);

  const logger = new NestLogger('Bootstrap');
  logger.log(
    `OB Track API listening on port ${config.port} [${config.nodeEnv}]`,
  );
  if (config.swaggerEnabled) {
    logger.log('API documentation available at /api/docs');
  }
}

// A rejected bootstrap must kill the process. Without this the promise rejects
// silently and you get a "running" container that serves nothing.
bootstrap().catch((error) => {
  // The logger may not exist yet at this point, so console is the honest choice.
  console.error('Failed to start application:', error);
  process.exit(1);
});
