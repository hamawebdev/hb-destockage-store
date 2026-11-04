// Structured logs for Workers Logs. Callers pass only operational fields (ids, counts, channel,
// order ref, error class). Never customer names, phones, addresses or row values.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
