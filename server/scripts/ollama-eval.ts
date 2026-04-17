/* Regression harness for the production Ollama notification extractor.
 *
 * Mirrors the `/api/generate` + `system` + `format: 'json'` call used by
 * `server/src/services/ollama-normalizer.ts`, runs it over a fixed set of
 * messy Revolut-style inputs, feeds the JSON output through `parseNotification`,
 * and prints a pass/fail table + summary.
 *
 * Usage:
 *   bun run server/scripts/ollama-eval.ts
 */
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:3b';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30000);

type Expect =
  | { kind: 'parses'; type: 'expense' | 'income' | 'refund'; amount: number; currency: string; merchant: string }
  | { kind: 'none' };

type Case = { id: string; input: string; expect: Expect };

// Cents helper: 9.99 -> 999
const c = (n: number) => Math.round(n * 100);

const CASES: Case[] = [
  // --- EXPENSES ---
  {
    id: 'exp-01-you-paid-at',
    input: 'You paid €9.99 at NETFLIX',
    expect: { kind: 'parses', type: 'expense', amount: c(9.99), currency: 'EUR', merchant: 'netflix' },
  },
  {
    id: 'exp-02-paid-no-you',
    input: 'Paid £15.20 at Pret A Manger with card',
    expect: { kind: 'parses', type: 'expense', amount: c(15.2), currency: 'GBP', merchant: 'pret a manger' },
  },
  {
    id: 'exp-03-paid-at-credit-noise',
    input: 'FreshMart: 🛒 Paid €5.11 at FreshMart\nCredit available: €1,000.00',
    expect: { kind: 'parses', type: 'expense', amount: c(5.11), currency: 'EUR', merchant: 'freshmart' },
  },
  {
    id: 'exp-04-paid-at-dual-currency',
    input: '🛍 Paid £11.20 (€12.94) at Smith & Sons\nAvailable credit: €2,000.00',
    expect: { kind: 'parses', type: 'expense', amount: c(11.2), currency: 'GBP', merchant: 'smith & sons' },
  },

  // --- INCOMING ---
  {
    id: 'inc-01-sent-you',
    input: 'ACME Corp sent you 40.00 EUR',
    expect: { kind: 'parses', type: 'income', amount: c(40), currency: 'EUR', merchant: 'acme corp' },
  },
  {
    id: 'inc-02-you-received',
    input: 'You received €1,500.00 from ACME Payroll',
    expect: { kind: 'parses', type: 'income', amount: c(1500), currency: 'EUR', merchant: 'acme payroll' },
  },
  {
    id: 'inc-03-received-from',
    input: 'Received £10.50 from BOB',
    expect: { kind: 'parses', type: 'income', amount: c(10.5), currency: 'GBP', merchant: 'bob' },
  },

  // --- REFUNDS ---
  {
    id: 'ref-01-refund-of',
    input: 'Refund of €8.00 from AMAZON',
    expect: { kind: 'parses', type: 'refund', amount: c(8), currency: 'EUR', merchant: 'amazon' },
  },
  {
    id: 'ref-02-you-were-refunded',
    input: 'You were refunded €12.99 by NETFLIX',
    expect: { kind: 'parses', type: 'refund', amount: c(12.99), currency: 'EUR', merchant: 'netflix' },
  },
  {
    id: 'ref-03-merchant-refunded',
    input: 'Booking.com refunded you £5.00',
    expect: { kind: 'parses', type: 'refund', amount: c(5), currency: 'GBP', merchant: 'booking.com' },
  },

  // --- NONE ---
  {
    id: 'non-01-premium-trial',
    input: 'Your Revolut Premium trial ends in 3 days. Upgrade to keep perks.',
    expect: { kind: 'none' },
  },
  {
    id: 'non-02-login-alert',
    input: 'New security alert: a new login from London was detected on your Revolut account',
    expect: { kind: 'none' },
  },
];

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

type JsonOut = { type: 'expense' | 'income' | 'refund' | 'none'; amount: number; currency: string; merchant: string };

async function callOllamaGenJson(system: string, prompt: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0, seed: 42, num_predict: 80 },
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { response?: unknown };
    return typeof j.response === 'string' ? j.response : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonOutput(raw: string): JsonOut | null {
  let s = raw.trim().replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const type = j.type;
    if (type !== 'expense' && type !== 'income' && type !== 'refund' && type !== 'none') return null;
    const amount = typeof j.amount === 'number' ? j.amount : Number(j.amount);
    if (!Number.isFinite(amount)) return null;
    const currency = String(j.currency ?? 'EUR').toUpperCase();
    const merchant = String(j.merchant ?? '');
    return { type, amount, currency, merchant };
  } catch {
    return null;
  }
}

function jsonToCanonical(j: JsonOut): string | null {
  if (j.type === 'none') return 'NONE';
  const sym = j.currency === 'EUR' ? '€' : j.currency === 'USD' ? '$' : j.currency === 'GBP' ? '£' : '';
  if (!sym) return null;
  const cents = Math.round(j.amount * 100);
  if (cents <= 0) return null;
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  const enAmt = `${whole}.${frac}`;
  const merch = j.merchant.trim();
  if (!merch) return null;
  if (j.type === 'expense') return `You paid ${sym}${enAmt} at ${merch}`;
  if (j.type === 'income') return `${merch} sent you ${sym}${enAmt}`;
  return `You were refunded ${sym}${enAmt} by ${merch}`;
}

type Result = { caseId: string; raw: string; cleaned: string; pass: boolean; reason: string };

async function runEval(): Promise<Result[]> {
  const out: Result[] = [];
  for (const cs of CASES) {
    const raw = (await callOllamaGenJson(SYSTEM_PROMPT, cs.input)) ?? '';
    const j = parseJsonOutput(raw);
    const cleaned = j ? (jsonToCanonical(j) ?? '') : '';
    let pass = false;
    let reason = '';
    if (cs.expect.kind === 'none') {
      if (j?.type === 'none' || !cleaned || cleaned === 'NONE') pass = true;
      else reason = `expected NONE but got ${j?.type ?? cleaned}`;
    } else if (!j) {
      reason = `json parse failed`;
    } else {
      const exp = cs.expect;
      const typeOk = j.type === exp.type;
      const amtOk = Math.round(j.amount * 100) === exp.amount;
      const curOk = j.currency === exp.currency;
      const merchOk = j.merchant.toLowerCase().replace(/\s+/g, ' ').trim() === exp.merchant;
      pass = typeOk && amtOk && curOk && merchOk;
      if (!pass) {
        const diff: string[] = [];
        if (!typeOk) diff.push(`type ${j.type}!=${exp.type}`);
        if (!amtOk) diff.push(`amount ${Math.round(j.amount * 100)}!=${exp.amount}`);
        if (!curOk) diff.push(`cur ${j.currency}!=${exp.currency}`);
        if (!merchOk) diff.push(`merch "${j.merchant}"!="${exp.merchant}"`);
        reason = diff.join(', ');
      }
    }
    out.push({ caseId: cs.id, raw: raw.replace(/\n/g, '\\n').slice(0, 160), cleaned, pass, reason });
  }
  return out;
}

function summarize(results: Result[]) {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const pct = ((passed / total) * 100).toFixed(1);
  console.log(`\n=== ${passed}/${total} (${pct}%) ===`);
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.caseId}  -> ${r.cleaned || '(empty)'}${r.reason ? `   [${r.reason}]` : ''}`);
    if (!r.pass) console.log(`      raw: ${r.raw}`);
  }
}

const res = await runEval();
summarize(res);
