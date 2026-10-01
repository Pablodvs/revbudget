import { MAX_CENTS } from 'shared';

export type TransactionType = 'expense' | 'income' | 'refund';

export type ParsedNotification = {
  type: TransactionType;
  amount: number;
  currency: string;
  merchant: string;
  merchantDisplay: string;
  transactionDate: string;
};

export type ParseError = {
  code: 'empty' | 'no_match' | 'invalid_amount';
  message: string;
};

export type ParseResult =
  | { ok: true; value: ParsedNotification }
  | { ok: false; error: ParseError };

const CURRENCY_SYMBOLS: Record<string, string> = {
  '€': 'EUR',
  $: 'USD',
  '£': 'GBP',
};

const AMOUNT = String.raw`(?:\d{1,3}(?:[,\u00A0 ]\d{3})*(?:\.\d{1,2})|\d+(?:\.\d{1,2})?)`;
const CURR = String.raw`(?:€|\$|£|EUR|USD|GBP)`;
const SPACE = String.raw`[\s\u00A0]+`;
// Amount ↔ currency boundary: Revolut sometimes glues them ("£11.20")
// and sometimes separates them ("£ 11.20"), so accept zero-or-more whitespace.
const AC_SEP = String.raw`[\s\u00A0]*`;
// Consume any leading run of emoji / punctuation / whitespace so the next
// anchor lands on the trigger word or merchant name. Excludes digits so
// merchant names starting with a digit (e.g. "3M") are preserved in
// merchant-first matchers like "X sent you …".
// Matched atomically (lookahead + backreference): under the `u` flag,
// JavaScriptCore backtracks a plain greedy `[^\p{L}\p{N}]*` in O(n²) over
// non-ASCII runs like "€€€…", and every matcher starts with it.
const EMOJI_PREFIX = String.raw`(?=(?<lead>[^\p{L}\p{N}]*))\k<lead>`;

type Matcher = {
  name: string;
  type: TransactionType;
  regex: RegExp;
};

const MATCHERS: Matcher[] = [
  {
    name: 'en-paid-at',
    type: 'expense',
    regex: new RegExp(
      `^${EMOJI_PREFIX}(?:You\\s+)?paid${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})${SPACE}at${SPACE}(?<merch>.+?)$`,
      'iu',
    ),
  },
  {
    name: 'en-you-received-from',
    type: 'income',
    regex: new RegExp(
      `^${EMOJI_PREFIX}You\\s+received${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})${SPACE}from${SPACE}(?<merch>.+?)$`,
      'iu',
    ),
  },
  {
    name: 'en-received-from',
    type: 'income',
    regex: new RegExp(
      `^${EMOJI_PREFIX}Received${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})${SPACE}from${SPACE}(?<merch>.+?)$`,
      'iu',
    ),
  },
  {
    name: 'en-sender-sent-you',
    type: 'income',
    regex: new RegExp(
      `^${EMOJI_PREFIX}(?<merch>.+?)\\s+sent\\s+you${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})$`,
      'iu',
    ),
  },
  {
    name: 'en-you-were-refunded-by',
    type: 'refund',
    regex: new RegExp(
      `^${EMOJI_PREFIX}You\\s+were\\s+refunded${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})${SPACE}by${SPACE}(?<merch>.+?)$`,
      'iu',
    ),
  },
  {
    name: 'en-refund-of-from',
    type: 'refund',
    regex: new RegExp(
      `^${EMOJI_PREFIX}Refund\\s+of${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})${SPACE}from${SPACE}(?<merch>.+?)$`,
      'iu',
    ),
  },
  {
    name: 'en-merchant-refunded-you',
    type: 'refund',
    regex: new RegExp(
      `^${EMOJI_PREFIX}(?<merch>.+?)\\s+refunded\\s+you${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})$`,
      'iu',
    ),
  },
  {
    name: 'en-youve-received-payment-refund',
    type: 'refund',
    regex: new RegExp(
      `^${EMOJI_PREFIX}You[\u2019']ve${SPACE}received${SPACE}a${SPACE}payment${SPACE}refund${SPACE}of${SPACE}(?<cur>${CURR})${AC_SEP}(?<amt>${AMOUNT})${SPACE}from${SPACE}(?<merch>.+?)$`,
      'iu',
    ),
  },
];

function normalizeMerchant(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseAmountToCents(raw: string): number | null {
  const stripped = raw
    .replace(/[\u00A0 ]/g, '')
    .split(',')
    .join('');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(stripped);
  if (!match) return null;
  const whole = Number(match[1]);
  const fracRaw = match[2] ?? '';
  const frac = fracRaw.padEnd(2, '0').slice(0, 2);
  if (Number.isNaN(whole)) return null;
  const fracNum = Number(frac);
  if (Number.isNaN(fracNum)) return null;
  const cents = whole * 100 + fracNum;
  // The same €1M cap the API and ollama-normalizer enforce: keeps absurd
  // notification amounts (and float precision loss) out of the ledger.
  return cents > MAX_CENTS ? null : cents;
}

function resolveCurrency(token: string): string {
  const upper = token.toUpperCase();
  if (upper === 'EUR' || upper === 'USD' || upper === 'GBP') return upper;
  return CURRENCY_SYMBOLS[token] ?? upper;
}

const BALANCE_LINE =
  /^(?:(?:Available|Current|Remaining)\s+(?:credit|balance)|Credit\s+(?:available|remaining)|Balance(?:\s+available)?)\b/i;
const TITLE_PREFIX = /^[^:\n]{1,60}:\s+/;
// Bounded on both sides of the currency: the unbounded `[^)]*…[^)]*` form
// backtracked in O(n⁴) on inputs like "(€(€(€…" (hours at the webhook's
// 4096-char cap). Surrounding whitespace is left to the collapse that follows.
const CURRENCY_PARENTHETICAL = /\([^()]{0,40}(?:€|\$|£|EUR|USD|GBP)[^()]{0,40}\)/giu;
const TRAILING_CARD = /\s+with\s+(?:your\s+|my\s+)?card(?:\s+\S+)*\s*$/i;

function preprocess(input: string): string {
  const kept = input
    .split(/\r?\n/)
    .filter((line) => !BALANCE_LINE.test(line.trim()))
    .join(' ');
  let text = kept.replace(/\s+/g, ' ').trim();
  text = text.replace(TITLE_PREFIX, '');
  text = text.replace(CURRENCY_PARENTHETICAL, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(TRAILING_CARD, '').trim();
  return text;
}

export function parseNotification(input: string, receivedAt?: Date): ParseResult {
  const text = input?.trim();
  if (!text) {
    return { ok: false, error: { code: 'empty', message: 'empty notification' } };
  }
  const single = preprocess(text);
  if (!single) {
    return { ok: false, error: { code: 'empty', message: 'empty notification' } };
  }
  for (const matcher of MATCHERS) {
    const m = matcher.regex.exec(single);
    if (!m || !m.groups) continue;
    const rawAmt = m.groups.amt ?? '';
    const curToken = m.groups.cur ?? '';
    const merchant = m.groups.merch ?? '';
    const amount = parseAmountToCents(rawAmt);
    if (amount === null || amount <= 0) {
      return {
        ok: false,
        error: { code: 'invalid_amount', message: `could not parse amount: ${rawAmt}` },
      };
    }
    const merchantDisplay = merchant.trim();
    return {
      ok: true,
      value: {
        type: matcher.type,
        amount,
        currency: resolveCurrency(curToken),
        merchant: normalizeMerchant(merchantDisplay),
        merchantDisplay,
        transactionDate: (receivedAt ?? new Date()).toISOString(),
      },
    };
  }
  return { ok: false, error: { code: 'no_match', message: 'no matcher matched' } };
}
