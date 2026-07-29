import { SetMetadata } from '@nestjs/common';

import { NO_ENVELOPE_KEY } from '../interceptors/response.interceptor';

/**
 * Opts a route (or a whole controller) out of the standard success envelope,
 * returning the handler's value verbatim.
 *
 * Use sparingly. It exists for endpoints consumed by machines that expect a
 * fixed shape we do not control — health checks scraped by Kubernetes or a
 * load balancer, for example.
 */
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);
