import { LocationPointDto } from './location-point.dto';

/**
 * Body for `POST /tasks/:id/end`.
 *
 * The end fix is exactly a location point — latitude, longitude, and the device
 * timestamp — so this extends `LocationPointDto` rather than restating the
 * fields. A separate named class still earns its place: it documents intent at
 * the call site (`end(dto: EndTaskDto)` reads better than a bare
 * `LocationPointDto`) and leaves an obvious home for any end-only field a later
 * phase adds, such as a completion note.
 *
 * ## Why the settlement amounts are NOT here
 *
 * They were, briefly, as a "settle in one call" shortcut. It was removed,
 * because having two routes write the same two columns with different
 * semantics for an omitted field is a trap:
 *
 *   - `POST /end` omitting an amount meant "don't write the column".
 *   - `PATCH /settlement` omitting one means "set it to 0" — it is a PATCH of
 *     the settlement as a whole, so clearing a box has to mean zero.
 *
 * A wizard whose amounts screen saves itself on mount would therefore wipe
 * amounts that had just been sent with `/end`, silently and with no error. The
 * office boy sees 500 on one screen and 0 in the ledger.
 *
 * The product flow has "end" and "enter the amounts" as separate screens
 * anyway, so `PATCH /tasks/:id/settlement` is the single way money is recorded.
 * Ending a task leaves the database defaults of 0 in place, which is exactly
 * what "the office boy has not entered anything yet" should mean.
 */
export class EndTaskDto extends LocationPointDto {}
