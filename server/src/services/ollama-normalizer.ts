import { config } from '../config';
import { log } from '../lib/log';
import { type ParsedNotification, parseNotification } from './notification-parser';

const SYSTEM_PROMPT = `You extract Revolut notifications into JSON: {"type":"expense"|"income"|"refund"|"none","amount":number,"currency":"EUR"|"USD"|"GBP","merchant":string}
Rules: expense=money OUT (paid,"paid X at Y",sent,charged,purchase). income=money IN, NOT a refund ("X sent you","received from",salary). refund=money BACK from merchant (refund,refunded,chargeback). none=anything else (set amount=0,merchant="").
CRITICAL direction: "you sent/paid X to Y"=EXPENSE. "X sent you / received from X"=INCOME.
IGNORE balance lines ("Credit available","Available credit","Available balance","Credit remaining") — those show your remaining balance, NOT the transaction amount. Also strip any leading app/title prefix ending in ":" (e.g. "FreshMart: …").
amount: dot decimal JSON number. currency: 3-letter (€=EUR,$=USD,£=GBP). merchant: copy EXACTLY as written in input, do NOT fix spelling.
Examples:
"You paid €9.99 at NETFLIX" -> {"type":"expense","amount":9.99,"currency":"EUR","merchant":"NETFLIX"}
"FreshMart: 🛒 Paid €5.11 at FreshMart\\nCredit available: €1,000.00" -> {"type":"expense","amount":5.11,"currency":"EUR","merchant":"FreshMart"}
"🛍 Paid £11.20 (€12.94) at Smith & Sons\\nAvailable credit: €2,000.00" -> {"type":"expense","amount":11.20,"currency":"GBP","merchant":"Smith & Sons"}
"ACME Corp sent you 40.00 EUR" -> {"type":"income","amount":40,"currency":"EUR","merchant":"ACME Corp"}
"You were refunded €5.00 by ZARA" -> {"type":"refund","amount":5,"currency":"EUR","merchant":"ZARA"}
"Your Revolut trial ends soon" -> {"type":"none","amount":0,"currency":"EUR","merchant":""}
Output ONLY the JSON object. No explanation.`;

type GenerateResponse = { response?: unknown };

type ExtractedTx = {
  type: 'expense' | 'income' | 'refund' | 'none';
  amount: number;
  currency: 'EUR' | 'USD' | 'GBP';
  merchant: string;
};

function parseJsonOutput(raw: string): ExtractedTx | null {
  let s = raw.trim().replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
  const braceMatch = s.match(/\{[\s\S]*\}/);
  if (braceMatch) s = braceMatch[0];
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const obj = j as Record<string, unknown>;
  const type = obj.type;
  if (type !== 'expense' && type !== 'income' && type !== 'refund' && type !== 'none') {
    return null;
  }
  const amountNum = typeof obj.amount === 'number' ? obj.amount : Number(obj.amount);
  // Upper bound guards against hallucinated mega-amounts polluting the ledger.
  if (!Number.isFinite(amountNum) || amountNum < 0 || amountNum > 1_000_000) return null;
  const curRaw = String(obj.currency ?? 'EUR').toUpperCase();
  if (curRaw !== 'EUR' && curRaw !== 'USD' && curRaw !== 'GBP') return null;
  const merchant = String(obj.merchant ?? '').trim();
  return { type, amount: amountNum, currency: curRaw, merchant };
}

function buildCanonical(j: ExtractedTx): string | null {
  if (j.type === 'none') return null;
  if (!j.merchant) return null;
  const cents = Math.round(j.amount * 100);
  if (cents <= 0) return null;
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  const enAmt = `${whole}.${frac}`;
  const sym = j.currency === 'EUR' ? '€' : j.currency === 'USD' ? '$' : '£';
  if (j.type === 'expense') {
    return `You paid ${sym}${enAmt} at ${j.merchant}`;
  }
  if (j.type === 'income') {
    return `${j.merchant} sent you ${sym}${enAmt}`;
  }
  return `You were refunded ${sym}${enAmt} by ${j.merchant}`;
}

export type NormalizerResult = {
  canonical: string;
  parsed: ParsedNotification;
};

export async function normalizeWithOllama(
  rawText: string,
  rid: string,
  receivedAt: Date,
): Promise<NormalizerResult | null> {
  if (!config.OLLAMA_ENABLED) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        system: SYSTEM_PROMPT,
        prompt: rawText,
        stream: false,
        format: 'json',
        options: { temperature: 0, seed: 42, num_predict: 80 },
      }),
    });
    if (!res.ok) {
      log.error(rid, 'ollama_normalize_failed', { status: res.status });
      return null;
    }
    const json = (await res.json()) as GenerateResponse;
    const raw = typeof json.response === 'string' ? json.response.trim() : '';
    const tookMs = Date.now() - startedAt;
    if (!raw) {
      log.info(rid, 'ollama_normalize_none', { tookMs, input: rawText });
      return null;
    }
    const extracted = parseJsonOutput(raw);
    if (!extracted) {
      log.warn(rid, 'ollama_normalize_invalid', { tookMs, input: rawText, output: raw });
      return null;
    }
    if (extracted.type === 'none') {
      log.info(rid, 'ollama_normalize_none', { tookMs, input: rawText, raw });
      return null;
    }
    const canonical = buildCanonical(extracted);
    if (!canonical) {
      log.warn(rid, 'ollama_normalize_invalid', { tookMs, input: rawText, raw, extracted });
      return null;
    }
    // Defense-in-depth: buildCanonical should always produce a string the
    // parser accepts, but if the two ever drift, catch it here instead of
    // inserting a malformed transaction.
    const validation = parseNotification(canonical, receivedAt);
    if (!validation.ok) {
      log.warn(rid, 'ollama_normalize_invalid', {
        tookMs,
        input: rawText,
        raw,
        output: canonical,
        errorCode: validation.error.code,
      });
      return null;
    }
    log.info(rid, 'ollama_normalize_ok', { tookMs, input: rawText, raw, output: canonical });
    return { canonical, parsed: validation.value };
  } catch (err) {
    log.error(rid, 'ollama_normalize_failed', { err: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
