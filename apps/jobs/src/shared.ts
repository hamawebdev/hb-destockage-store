// Single import point for @hb/shared. Relative path until packages/shared/package.json gets an
// "exports" map (asked of tooling); then this becomes `from '@hb/shared'`.
export { parseOrderCreatedMessage, type OrderCreatedMessage } from '../../../packages/shared/src/messages.ts';
export { formatPrice } from '../../../packages/shared/src/format.ts';
export type { Lang } from '../../../packages/shared/src/lang.ts';
