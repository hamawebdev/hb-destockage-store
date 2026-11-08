import { describe, expect, it } from 'vitest';
import { checkViolation, isForeignKeyViolation, uniqueViolation } from './db-errors.ts';

describe('D1 constraint error mapping', () => {
  const d1 = (msg: string) => new Error(`D1_ERROR: ${msg}: SQLITE_CONSTRAINT`, { cause: new Error(msg) });

  it('unique: table and column', () => {
    expect(uniqueViolation(d1('UNIQUE constraint failed: categories.slug_fr'))).toEqual({ table: 'categories', column: 'slug_fr' });
    expect(uniqueViolation(d1('UNIQUE constraint failed: variants.sku'))).toEqual({ table: 'variants', column: 'sku' });
    expect(uniqueViolation(new Error('something else'))).toBeNull();
    expect(uniqueViolation('UNIQUE constraint failed: x.y')).toEqual({ table: 'x', column: 'y' });
  });

  it('foreign key', () => {
    expect(isForeignKeyViolation(d1('FOREIGN KEY constraint failed'))).toBe(true);
    expect(isForeignKeyViolation(new Error('UNIQUE constraint failed: a.b'))).toBe(false);
  });

  it('check constraint name', () => {
    expect(checkViolation(d1('CHECK constraint failed: delivery_fees_fee_nonneg'))).toBe('delivery_fees_fee_nonneg');
    expect(checkViolation(new Error('nope'))).toBeNull();
  });
});
