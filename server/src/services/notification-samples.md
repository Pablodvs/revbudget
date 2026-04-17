# Revolut notification samples

Paste here the **literal** texts you receive from Revolut for each movement type.
Used to build the regex in `notification-parser.ts` and assign the correct `type`
(`expense`, `income`, `refund`, `adjustment`).

Rules:
- Copy the text exactly as it arrives (emojis, spaces, line breaks included).
- If you have multiple formats for the same type, add all of them.
- Replace sensitive data (names, amounts) only if you want to; the parser looks at structure.

---

## 1. Expenses (`expense`) — CURRENTLY SUPPORTED

Reference of what `notification-parser.ts` parses today:

```
You paid €12.34 at MERCADONA
Paid £11.20 at Smith & Sons
Paid £5.00 at Tesco with card
```

### 1.1 Card payment (in-store / online)
```
<paste real text here>
```

### 1.2 Transfer sent / payment to a person
```
<paste real text here>
```

### 1.3 ATM withdrawal
```
<paste real text here>
```

---

## 2. Income (`income`)

Possible cases: salary, incoming transfer, received payment, tax refund, etc.

### 2.1 Incoming transfer
```
<paste real text here>
```

### 2.2 Salary / recurring deposit
```
<paste real text here>
```

### 2.3 Other (specify)
```
<paste real text here>
```

---

## 3. Refunds (`refund`)

When a merchant returns money from a previous purchase.

### 3.1 Merchant refund
```
<paste real text here>
```

### 3.2 Chargeback / reversal
```
<paste real text here>
```

---

## 4. Price adjustments (`adjustment`)

Revolut sometimes changes the final amount of a pending charge (e.g. tip added later,
adjusted currency conversion, preliminary authorisation different from final charge).

### 4.1 Upward adjustment (final charge > preliminary charge)
```
<paste real text here, if any>
```

### 4.2 Downward adjustment (final charge < preliminary charge)
```
<paste real text here, if any>
```

> If you never receive this type of notification, leave it empty and we'll keep it
> out of the parser (manual entry only from the dashboard).

---

## Notes

- For each type with at least one sample, a new `Matcher` will be added in
  `server/src/services/notification-parser.ts` with the matching `type`.
- If an income/refund cannot be automatically linked to an original transaction,
  `relatedTxId` will stay null and can be associated manually from the dashboard.
- The current regex uses the helpers `AMOUNT`, `CURR`, `SPACE`, `AC_SEP` — reuse them for consistency.
