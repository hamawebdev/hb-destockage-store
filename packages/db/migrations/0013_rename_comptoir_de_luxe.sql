-- REBR-6: the store is renamed HB Destockage -> Comptoir de Luxe (Arabic كونتوار دو لوكس).
-- Data only, no schema change; plain UPDATEs, no row added or deleted. Idempotent: a second run matches
-- no row. Conservative: only values that still hold the old name change, so a name the owner already
-- edited in the admin is left alone. A no-op on an empty database (migrations run before the seed
-- locally; the seed in data/ already carries the new name). 0010 (applied) is not edited.
--
-- settings.storeName is {"fr": "...", "ar": "..."}: one statement per language, each replacing the value only
-- where it holds the old name (Latin, or the Arabic transliteration once used in the admin). A missing key
-- is not matched, so none is added.
UPDATE `settings` SET `value` = json_set(`value`, '$.fr', 'Comptoir de Luxe'), `updated_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE `key` = 'storeName' AND json_extract(`value`, '$.fr') LIKE '%HB Destockage%';
--> statement-breakpoint
UPDATE `settings` SET `value` = json_set(`value`, '$.ar', 'كونتوار دو لوكس'), `updated_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE `key` = 'storeName' AND (json_extract(`value`, '$.ar') LIKE '%HB Destockage%' OR json_extract(`value`, '$.ar') LIKE '%إتش بي ديستوكاج%');
--> statement-breakpoint
-- Content pages (about, contact, legal…): the name inside titles, summaries and bodies. French columns
-- get the Latin name, Arabic columns the Arabic name. instr() is case-sensitive like replace(), so a row
-- is matched only when a replacement really happens (a second run matches nothing).
UPDATE `content_pages` SET `title_fr` = replace(`title_fr`, 'HB Destockage', 'Comptoir de Luxe'), `summary_fr` = replace(`summary_fr`, 'HB Destockage', 'Comptoir de Luxe'), `body_fr` = replace(`body_fr`, 'HB Destockage', 'Comptoir de Luxe'), `title_ar` = replace(`title_ar`, 'HB Destockage', 'كونتوار دو لوكس'), `summary_ar` = replace(`summary_ar`, 'HB Destockage', 'كونتوار دو لوكس'), `body_ar` = replace(`body_ar`, 'HB Destockage', 'كونتوار دو لوكس'), `updated_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE instr(`title_fr`, 'HB Destockage') > 0 OR instr(`summary_fr`, 'HB Destockage') > 0 OR instr(`body_fr`, 'HB Destockage') > 0 OR instr(`title_ar`, 'HB Destockage') > 0 OR instr(`summary_ar`, 'HB Destockage') > 0 OR instr(`body_ar`, 'HB Destockage') > 0;
