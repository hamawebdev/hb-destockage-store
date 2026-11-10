-- REBR-6: the store is renamed HB Destockage -> Comptoir de Luxe (Arabic كونتوار دو لوكس).
-- Data only, no schema change; plain UPDATEs, no row added or deleted. Idempotent: a second run matches
-- no row. Conservative: only values that still hold the old name change, so a name the owner already
-- edited in the admin is left alone. A no-op on an empty database (migrations run before the seed
-- locally; the seed in data/ already carries the new name). 0010 (applied) is not edited.
--
-- settings.storeName is {"fr": "...", "ar": "..."}: each language is replaced only where it holds the
-- old name (Latin, or the Arabic transliteration once used in the admin).
UPDATE `settings` SET `value` = json_set(`value`, '$.fr', CASE WHEN json_extract(`value`, '$.fr') LIKE '%HB Destockage%' THEN 'Comptoir de Luxe' ELSE json_extract(`value`, '$.fr') END, '$.ar', CASE WHEN json_extract(`value`, '$.ar') LIKE '%HB Destockage%' OR json_extract(`value`, '$.ar') LIKE '%إتش بي ديستوكاج%' THEN 'كونتوار دو لوكس' ELSE json_extract(`value`, '$.ar') END), `updated_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE `key` = 'storeName' AND (`value` LIKE '%HB Destockage%' OR `value` LIKE '%إتش بي ديستوكاج%');
--> statement-breakpoint
-- Content pages (about, contact, legal…): the name inside titles, summaries and bodies. French columns
-- get the Latin name, Arabic columns the Arabic name.
UPDATE `content_pages` SET `title_fr` = replace(`title_fr`, 'HB Destockage', 'Comptoir de Luxe'), `summary_fr` = replace(`summary_fr`, 'HB Destockage', 'Comptoir de Luxe'), `body_fr` = replace(`body_fr`, 'HB Destockage', 'Comptoir de Luxe'), `title_ar` = replace(`title_ar`, 'HB Destockage', 'كونتوار دو لوكس'), `summary_ar` = replace(`summary_ar`, 'HB Destockage', 'كونتوار دو لوكس'), `body_ar` = replace(`body_ar`, 'HB Destockage', 'كونتوار دو لوكس'), `updated_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE `title_fr` LIKE '%HB Destockage%' OR `summary_fr` LIKE '%HB Destockage%' OR `body_fr` LIKE '%HB Destockage%' OR `title_ar` LIKE '%HB Destockage%' OR `summary_ar` LIKE '%HB Destockage%' OR `body_ar` LIKE '%HB Destockage%';
