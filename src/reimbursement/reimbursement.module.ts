import { Module } from '@nestjs/common';

import { ReimbursementRateService } from './reimbursement-rate.service';

/**
 * The per-kilometre rate history and the money calculation built on it.
 *
 * Its own module rather than living inside `AdminModule` because BOTH sides of
 * the app need it: the admin's reimbursement report, and the office boy's own
 * KPI screen ("what have I earned back this month"). `AdminModule` already
 * imports `TasksModule`, so putting the rate service in either of those would
 * make the other import it back and create a cycle. A leaf module both can
 * depend on is the shape that has no such problem.
 *
 * Prisma is global, so nothing needs importing here.
 */
@Module({
  providers: [ReimbursementRateService],
  exports: [ReimbursementRateService],
})
export class ReimbursementModule {}
