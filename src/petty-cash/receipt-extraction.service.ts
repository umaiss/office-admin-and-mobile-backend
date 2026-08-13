import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { PettyCashCategory } from '../generated/prisma/enums';
import type { AllowedReceiptMimeType } from '../storage/file-type';

/** What the model managed to read off a receipt. Every field is optional. */
export interface ReceiptExtraction {
  amount?: number;
  vendor?: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  date?: string;
  category?: PettyCashCategory;
  description?: string;
  /** 0-1. Zero whenever nothing usable came back. */
  confidence: number;
  /** Set when extraction did not run or did not succeed. */
  failureReason?: string;
}

/** The categories the model may choose from, taken from the database enum. */
const CATEGORIES = Object.values(PettyCashCategory);

/**
 * The shape the model must return.
 *
 * Nullable fields use `anyOf` rather than a `["string","null"]` type array —
 * structured outputs accept the former. Every field is required and
 * `additionalProperties` is false, so the response either validates completely
 * or the API rejects it; there is no half-filled object to guard against.
 */
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'amount',
    'vendor',
    'date',
    'category',
    'description',
    'confidence',
  ],
  properties: {
    amount: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description:
        'The total actually paid, as a number. Not the subtotal, and not a per-item price. Null if no total is legible.',
    },
    vendor: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The business the money was paid to, as printed. Null if not legible.',
    },
    date: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The date on the receipt as YYYY-MM-DD. Null if absent or ambiguous.',
    },
    category: {
      anyOf: [{ type: 'string', enum: CATEGORIES }, { type: 'null' }],
      description:
        'Best-fit expense category for what was bought. Null if nothing fits.',
    },
    description: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'One short line naming what was actually purchased, from the line items. Not the vendor name again.',
    },
    confidence: {
      type: 'number',
      description:
        'Your confidence, 0 to 1, that amount, vendor and date are all correct and this is a purchase receipt.',
    },
  },
} as const;

const SYSTEM_PROMPT = `You read petty cash receipts for an office expense ledger and return the fields needed to file one expense.

Report what is printed on the receipt. Do not infer a total that is not shown, convert currencies, or fill a field from what a receipt like this usually says — a null costs the admin one typed field, a confident wrong value costs them a corrected financial record.

Set confidence to reflect the whole extraction, not your best field. Legible printed receipt with a clear total, vendor and date: high. Anything creased, cropped, blurry, handwritten, in an unfamiliar layout, or showing several totals you had to choose between: low. If the image is not a purchase receipt at all, return nulls with confidence 0.`;

/**
 * Reads receipts with Claude.
 *
 * Two properties this class guarantees to its caller, both deliberate:
 *
 *   • It never throws. A model outage, a rate limit, a refusal, or a malformed
 *     response all come back as an extraction with `confidence: 0` and a
 *     `failureReason`. Filing an expense must not depend on an external
 *     service being up — the admin types the fields instead.
 *   • It is optional. With no API key configured, `enabled` is false and every
 *     call returns an empty extraction. The scan endpoint then behaves exactly
 *     as it did before extraction existed.
 */
@Injectable()
export class ReceiptExtractionService {
  private readonly logger = new Logger(ReceiptExtractionService.name);
  private readonly client?: Anthropic;

  constructor(private readonly config: AppConfigService) {
    const apiKey = this.config.anthropicApiKey;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    } else {
      this.logger.warn(
        'ANTHROPIC_API_KEY is not set — receipt scanning will store files but extract nothing.',
      );
    }
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  async extract(
    buffer: Buffer,
    mimeType: AllowedReceiptMimeType,
  ): Promise<ReceiptExtraction> {
    if (!this.client) {
      return { confidence: 0, failureReason: 'Extraction is not configured.' };
    }

    try {
      const response = await this.client.messages.create({
        model: this.config.anthropicModel,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        // Low effort: reading a receipt is perception, not reasoning. Higher
        // effort buys deliberation this task has little use for, and every
        // scan is a user waiting on a spinner.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
        },
        messages: [
          {
            role: 'user',
            content: [
              this.sourceBlock(buffer, mimeType),
              {
                type: 'text',
                text: `Extract the expense fields from this receipt. Today is ${new Date().toISOString().slice(0, 10)}; a receipt dated later than today is a misread, so prefer null over a future date.`,
              },
            ],
          },
        ],
      });

      // Safety classifiers can decline a request, and that arrives as a normal
      // 200 with an empty `content`. Reading content[0] first would throw here.
      if (response.stop_reason === 'refusal') {
        return {
          confidence: 0,
          failureReason: 'The model declined to read this image.',
        };
      }
      if (response.stop_reason === 'max_tokens') {
        return {
          confidence: 0,
          failureReason: 'The extraction response was truncated.',
        };
      }

      const text = response.content.find((block) => block.type === 'text');
      if (!text) {
        return { confidence: 0, failureReason: 'No extraction was returned.' };
      }

      return this.parse(text.text);
    } catch (error) {
      // Includes rate limits, timeouts, and connection failures. Logged for us,
      // degraded to manual entry for the admin.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Receipt extraction failed: ${message}`);
      return {
        confidence: 0,
        failureReason: 'Extraction service unavailable.',
      };
    }
  }

  private sourceBlock(
    buffer: Buffer,
    mimeType: AllowedReceiptMimeType,
  ): Anthropic.ContentBlockParam {
    const data = buffer.toString('base64');

    // A PDF receipt is a document, not an image — sending it as an image block
    // is rejected outright, so the block type has to follow the file type.
    if (mimeType === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      };
    }

    return {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data },
    };
  }

  /**
   * Turns the model's JSON into an extraction, dropping anything that does not
   * survive validation.
   *
   * The schema constrains the response, but this still re-checks every value:
   * a negative amount or a `2026-13-45` date would validate as
   * number-and-string while being nonsense to book. Each field is discarded
   * independently, so one bad field costs one field rather than the whole scan.
   */
  private parse(raw: string): ReceiptExtraction {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        confidence: 0,
        failureReason: 'Extraction response was not valid JSON.',
      };
    }

    const confidence =
      typeof parsed.confidence === 'number' &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : 0;

    const result: ReceiptExtraction = { confidence };

    if (
      typeof parsed.amount === 'number' &&
      Number.isFinite(parsed.amount) &&
      parsed.amount > 0
    ) {
      // The ledger stores two decimal places; round here so the value the admin
      // is shown is the value that gets written.
      result.amount = Math.round(parsed.amount * 100) / 100;
    }

    if (typeof parsed.vendor === 'string' && parsed.vendor.trim()) {
      result.vendor = parsed.vendor.trim().slice(0, 200);
    }

    if (typeof parsed.description === 'string' && parsed.description.trim()) {
      result.description = parsed.description.trim().slice(0, 500);
    }

    if (typeof parsed.date === 'string' && isCalendarDate(parsed.date)) {
      result.date = parsed.date;
    }

    if (
      typeof parsed.category === 'string' &&
      (CATEGORIES as string[]).includes(parsed.category)
    ) {
      result.category = parsed.category as PettyCashCategory;
    }

    return result;
  }
}

/**
 * True for a real `YYYY-MM-DD` calendar date.
 *
 * The round-trip through Date catches the values a regex cannot: `2026-02-30`
 * matches the pattern but rolls over to March 2nd, and booking an expense
 * against a day that does not exist is worse than asking the admin to type it.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
