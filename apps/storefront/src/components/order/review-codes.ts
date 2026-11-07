/**
 * Error codes web's Worker may un-hide on the no-JS review step (artifacts/WEB-3/review-slots.md, frozen), and the ones
 * also shown under their field. Owner: orderform (ORDER-6).
 */
export const REVIEW_ERROR_CODES = [
  'name_required', 'name_invalid', 'phone_required', 'phone_invalid', 'phone_not_mobile', 'wilaya_invalid', 'commune_invalid',
  'variant_required', 'variant_unavailable', 'qty_invalid', 'items_invalid', 'out_of_stock', 'delivery_unavailable',
  'total_changed', 'order_total_out_of_range', 'rate_limited', 'server_error',
] as const;

export const REVIEW_FIELD_CODES = {
  name: ['name_required', 'name_invalid'],
  phone: ['phone_required', 'phone_invalid', 'phone_not_mobile'],
  commune: ['commune_invalid'],
} as const;
