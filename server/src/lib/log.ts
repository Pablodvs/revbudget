import { redact } from './redact';

type Meta = Record<string, unknown> | undefined;

function serialize(meta: Meta): string {
  if (!meta) return '';
  try {
    return ` ${JSON.stringify(redact(meta))}`;
  } catch {
    return ' [unserializable_meta]';
  }
}

function format(rid: string, event: string, meta: Meta): string {
  return `[${rid}] ${event}${serialize(meta)}`;
}

export const log = {
  info(rid: string, event: string, meta?: Meta): void {
    console.log(format(rid, event, meta));
  },
  warn(rid: string, event: string, meta?: Meta): void {
    console.warn(format(rid, event, meta));
  },
  error(rid: string, event: string, meta?: Meta): void {
    console.error(format(rid, event, meta));
  },
};
