import type { AppConfigService } from '../config/app-config.service';
import { ReceiptExtractionService } from './receipt-extraction.service';

/**
 * The model is stubbed rather than called: what is worth pinning here is this
 * class's contract with the ledger, not the model's reading ability.
 *
 * That contract is narrow and load-bearing. Every field is re-validated after
 * the model returns it — a negative total, a 30th of February, or a category
 * that is not in the database enum all satisfy "number" and "string" while
 * being unbookable — and nothing that goes wrong is allowed to throw, because
 * filing an expense must never depend on an external service being up.
 */
describe('ReceiptExtractionService', () => {
  let service: ReceiptExtractionService;
  let create: jest.Mock;

  const config = {
    anthropicApiKey: 'sk-ant-test',
    anthropicModel: 'claude-opus-4.8',
  } as AppConfigService;

  /** A successful response carrying the model's JSON. */
  const responds = (payload: Record<string, unknown>) =>
    create.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    });

  const complete = (overrides: Record<string, unknown> = {}) => ({
    amount: 2145.5,
    vendor: 'Shell Petrol Station',
    date: '2026-08-05',
    category: 'FUEL',
    description: 'Diesel, 32 litres',
    confidence: 0.93,
    ...overrides,
  });

  const buffer = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  /** The request body passed to the nth `messages.create` call. */
  const request = (index = 0): Record<string, unknown> =>
    (create.mock.calls[index] as Record<string, unknown>[])[0];

  beforeEach(() => {
    create = jest.fn();
    service = new ReceiptExtractionService(config);
    // The SDK client is built in the constructor; swap its transport.
    (
      service as unknown as { client: { messages: { create: jest.Mock } } }
    ).client = { messages: { create } };
  });

  it('is enabled when a key is configured', () => {
    expect(service.enabled).toBe(true);
  });

  describe('without an API key', () => {
    it('reports itself unavailable and never calls the model', async () => {
      const offline = new ReceiptExtractionService({
        anthropicApiKey: undefined,
        anthropicModel: 'claude-opus-5',
      } as AppConfigService);

      expect(offline.enabled).toBe(false);

      const result = await offline.extract(buffer(), 'image/jpeg');
      expect(result.confidence).toBe(0);
      expect(result.failureReason).toBe('Extraction is not configured.');
    });
  });

  describe('request shape', () => {
    it('sends an image as an image block', async () => {
      responds(complete());

      await service.extract(buffer(), 'image/png');

      const content = (
        request().messages as { content: Record<string, unknown>[] }[]
      )[0].content;
      expect(content[0]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png' },
      });
    });

    it('sends a PDF as a document block', async () => {
      // A PDF wrapped in an image block is rejected outright by the API, so the
      // block type has to follow the file type rather than defaulting.
      responds(complete());

      await service.extract(buffer(), 'application/pdf');

      const content = (
        request().messages as { content: Record<string, unknown>[] }[]
      )[0].content;
      expect(content[0]).toMatchObject({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf' },
      });
    });

    it('constrains the response to the extraction schema', async () => {
      responds(complete());

      await service.extract(buffer(), 'image/jpeg');

      const outputConfig = request().output_config as {
        format: { type: string; schema: { required: string[] } };
      };
      expect(outputConfig.format.type).toBe('json_schema');
      expect(outputConfig.format.schema.required).toContain('confidence');
    });
  });

  describe('successful extraction', () => {
    it('returns every field the model read', async () => {
      responds(complete());

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result).toEqual({
        amount: 2145.5,
        vendor: 'Shell Petrol Station',
        date: '2026-08-05',
        category: 'FUEL',
        description: 'Diesel, 32 litres',
        confidence: 0.93,
      });
    });

    it('rounds the amount to the two decimals the ledger stores', async () => {
      responds(complete({ amount: 10.567 }));

      const result = await service.extract(buffer(), 'image/jpeg');

      // Otherwise the value shown to the admin and the value written to the
      // ledger differ in the third decimal.
      expect(result.amount).toBe(10.57);
    });
  });

  describe('field validation', () => {
    it.each([
      ['a negative amount', { amount: -5 }],
      ['a zero amount', { amount: 0 }],
      ['a non-numeric amount', { amount: 'PKR 500' }],
    ])('drops %s', async (_label, override) => {
      responds(complete(override));

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.amount).toBeUndefined();
      // One bad field costs one field — the rest of the scan survives.
      expect(result.vendor).toBe('Shell Petrol Station');
    });

    it.each([
      ['a date that does not exist', '2026-02-30'],
      ['a non-ISO date', '05/08/2026'],
      ['a partial date', '2026-08'],
    ])('drops %s', async (_label, date) => {
      responds(complete({ date }));

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.date).toBeUndefined();
    });

    it('keeps a real leap day', async () => {
      responds(complete({ date: '2028-02-29' }));

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.date).toBe('2028-02-29');
    });

    it('drops a category that is not in the database enum', async () => {
      responds(complete({ category: 'PETROL' }));

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.category).toBeUndefined();
    });

    it.each([
      ['above 1', 1.4],
      ['below 0', -0.2],
      ['not a number', 'high'],
    ])('treats confidence %s as zero', async (_label, confidence) => {
      responds(complete({ confidence }));

      const result = await service.extract(buffer(), 'image/jpeg');

      // Zero keeps it below any threshold, so a nonsense score can never
      // auto-file an expense.
      expect(result.confidence).toBe(0);
    });

    it('drops blank strings rather than storing whitespace', async () => {
      responds(complete({ vendor: '   ', description: '' }));

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.vendor).toBeUndefined();
      expect(result.description).toBeUndefined();
    });
  });

  describe('failure handling', () => {
    it('handles a refusal without reading empty content', async () => {
      // A declined request is a 200 with an empty content array — indexing
      // content[0] here would throw instead of degrading.
      create.mockResolvedValue({ stop_reason: 'refusal', content: [] });

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.confidence).toBe(0);
      expect(result.failureReason).toContain('declined');
    });

    it('handles a truncated response', async () => {
      create.mockResolvedValue({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{"amount": 21' }],
      });

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.confidence).toBe(0);
      expect(result.failureReason).toContain('truncated');
    });

    it('handles a response with no text block', async () => {
      create.mockResolvedValue({ stop_reason: 'end_turn', content: [] });

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.confidence).toBe(0);
    });

    it('handles malformed JSON', async () => {
      create.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not json at all' }],
      });

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.confidence).toBe(0);
      expect(result.failureReason).toContain('JSON');
    });

    it('never throws when the API call fails', async () => {
      // Rate limits, timeouts, outages. Filing an expense must not depend on
      // an external service being reachable.
      create.mockRejectedValue(new Error('429 rate limit exceeded'));

      const result = await service.extract(buffer(), 'image/jpeg');

      expect(result.confidence).toBe(0);
      expect(result.failureReason).toContain('unavailable');
    });
  });
});
