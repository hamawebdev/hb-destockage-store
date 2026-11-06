-- DB-2 (lead ruling via rev-e): marks invented seed fees. Default false: a fee the owner saves in the
-- admin is real; only the local seed writes true (data/geo/fees.seed.json).
ALTER TABLE `delivery_fees` ADD `placeholder` integer DEFAULT false NOT NULL;