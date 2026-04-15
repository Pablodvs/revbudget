export type ParsedNotification = {
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

const AMOUNT = String.raw`(\d{1,3}(?:[.\u00A0 ]\d{3})*(?:,\d{1,2})|\d+(?:,\d{1,2})?)`;
const CURR = String.raw`(€|\$|£|EUR|USD|GBP)`;
const SPACE = String.raw`[\s\u00A0]+`;

type Matcher = {
  name: string;
  regex: RegExp;
  extract: (m: RegExpMatchArray) => { raw: string; currency: string; merchant: string };
};

const MATCHERS: Matcher[] = [
  {
    name: 'pagaste-con-tarjeta',
    regex: new RegExp(
      `^(?:[\\p{Emoji}\\s]*)?Pagaste${SPACE}${AMOUNT}${SPACE}${CURR}${SPACE}con\\s+tu\\s+tarjeta\\s+en${SPACE}(.+?)$`,
      'iu',
    ),
    extract: (m) => ({ raw: m[1] ?? '', currency: m[2] ?? '', merchant: m[3] ?? '' }),
  },
  {
    name: 'pagaste-en',
    regex: new RegExp(
      `^(?:[\\p{Emoji}\\s]*)?Pagaste${SPACE}${AMOUNT}${SPACE}${CURR}${SPACE}en${SPACE}(.+?)$`,
      'iu',
    ),
    extract: (m) => ({ raw: m[1] ?? '', currency: m[2] ?? '', merchant: m[3] ?? '' }),
  },
  {
    name: 'enviaste-a',
    regex: new RegExp(
      `^(?:[\\p{Emoji}\\s]*)?Enviaste${SPACE}${AMOUNT}${SPACE}${CURR}${SPACE}a${SPACE}(.+?)$`,
      'iu',
    ),
    extract: (m) => ({ raw: m[1] ?? '', currency: m[2] ?? '', merchant: m[3] ?? '' }),
  },
];

function normalizeMerchant(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replace(/[.\u00A0 ]/g, '');
  const match = /^(\d+)(?:,(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fracRaw = match[2] ?? '';
  const frac = fracRaw.padEnd(2, '0').slice(0, 2);
  if (Number.isNaN(whole)) return null;
  const fracNum = Number(frac);
  if (Number.isNaN(fracNum)) return null;
  return whole * 100 + fracNum;
}

function resolveCurrency(token: string): string {
  const upper = token.toUpperCase();
  if (upper === 'EUR' || upper === 'USD' || upper === 'GBP') return upper;
  return CURRENCY_SYMBOLS[token] ?? upper;
}

export function parseNotification(input: string, receivedAt?: Date): ParseResult {
  const text = input?.trim();
  if (!text) {
    return { ok: false, error: { code: 'empty', message: 'empty notification' } };
  }
  const single = text.replace(/\s+/g, ' ').trim();
  for (const matcher of MATCHERS) {
    const m = matcher.regex.exec(single);
    if (!m) continue;
    const { raw, currency, merchant } = matcher.extract(m);
    const amount = parseAmountToCents(raw);
    if (amount === null || amount <= 0) {
      return {
        ok: false,
        error: { code: 'invalid_amount', message: `could not parse amount: ${raw}` },
      };
    }
    const merchantDisplay = merchant.trim();
    return {
      ok: true,
      value: {
        amount,
        currency: resolveCurrency(currency),
        merchant: normalizeMerchant(merchantDisplay),
        merchantDisplay,
        transactionDate: (receivedAt ?? new Date()).toISOString(),
      },
    };
  }
  return { ok: false, error: { code: 'no_match', message: 'no matcher matched' } };
}
