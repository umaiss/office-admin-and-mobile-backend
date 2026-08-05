import { PaginationMetaDto } from '../dto/api-response.dto';

/**
 * Builds the pagination envelope every list endpoint returns.
 *
 * This block was written out by hand in four services — users, tasks, admin,
 * employees — which is four chances for one of them to compute `hasNextPage`
 * differently from the rest. One function means a paginated list behaves the
 * same everywhere, and a future change (cursor pagination, a `from`/`to` count
 * hint) has exactly one place to land.
 *
 * `totalPages` is 0 for an empty result, not 1: "there are zero pages of
 * results" is the honest answer, and a client rendering "Page 1 of 0" has been
 * told something true.
 */
export function buildPaginationMeta(
  page: number,
  limit: number,
  total: number,
): PaginationMetaDto {
  const totalPages = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
