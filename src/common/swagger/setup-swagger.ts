import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mounts interactive API documentation at `/api/docs`.
 *
 * Swagger reads the decorators already on our controllers and DTOs and builds
 * an OpenAPI specification from them. That matters more than it sounds:
 * hand-written API docs drift out of date the moment someone changes a field
 * and forgets the document. Generated docs cannot drift, because they ARE the
 * code.
 *
 * The page is also a working client — the React and React Native developers can
 * call every endpoint from the browser before writing a line of their own code.
 *
 * It is disabled by default and switched on per environment via
 * `SWAGGER_ENABLED`, because in production it publishes a complete map of your
 * API surface to anyone who visits the URL.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('OB Track API')
    .setDescription(
      [
        'Backend for the OB Track office-boy tracking and management system.',
        '',
        '**Authentication.** Call `POST /auth/login` to obtain an access token and a',
        'refresh token. Send the access token on every subsequent request as',
        '`Authorization: Bearer <accessToken>`. Access tokens expire quickly; use',
        '`POST /auth/refresh` to obtain a new one rather than asking the user to log',
        'in again.',
        '',
        '**Response shape.** Successful responses are wrapped as',
        '`{ success: true, data: ... }`. Failures are',
        '`{ success: false, statusCode, message, error, requestId }`. Quote the',
        '`requestId` when reporting a problem — it locates the exact server logs.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste the accessToken returned by /auth/login.',
      },
      // This name is referenced by @ApiBearerAuth('access-token') on protected
      // routes, so the docs show a padlock and the "Authorize" button works.
      'access-token',
    )
    .addTag('Health', 'Liveness and readiness probes')
    .addTag('Auth', 'Login, token refresh, logout')
    .addTag('Users', 'Account and office boy management')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      // Keeps your token after a page reload — a small thing that saves a lot
      // of re-authenticating while developing.
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'OB Track API Docs',
  });
}
