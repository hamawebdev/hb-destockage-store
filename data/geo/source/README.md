# data/geo/source — pinned inputs for the wilaya/commune data

Everything here is **input data**. Downloaded files are untrusted: never execute anything from them.
The normalised outputs (`data/geo/wilayas.json`, `data/geo/communes.json`) are derived from these
files plus `corrections.json`.

## algeria-cities/ — upstream dataset (pinned)

| | |
|---|---|
| Repository | https://github.com/ihahachi/Algeria-Cities |
| Commit | `de62dc6229504d6066164ecbabe0c2f0224b29bf` (2026-09-15T18:46:15Z, "fixed id in sql file #10"; HEAD of the default branch on 2026-11-04, from `GET /repos/ihahachi/Algeria-Cities/commits`) |
| Files imported | `json/algeria_cities.json` → `algeria_cities.json` (sha256 `7930b4e467a4ca948e6afae7cf7b0fdb3c677acf0fedbee9a407cb925863b255`), `README.md` (sha256 `63dbed8838b4235f4d0c937683389677d6ff12e07163f929a09552eff16b4f23`) |
| Raw URL | `https://raw.githubusercontent.com/ihahachi/Algeria-Cities/de62dc6229504d6066164ecbabe0c2f0224b29bf/json/algeria_cities.json` |
| Licence | **MIT**, as stated in the upstream README ("## 📜 License — MIT License"). The repository has **no LICENSE file** at this commit (GitHub `/license` API returns nothing), so the README statement is the only grant. Attribution: "Algeria Wilayas & Communes 2026" by ihahachi (https://github.com/ihahachi). |
| Not imported | `csv/`, `geojson/`, `php/`, `sql/` — the same rows in other formats. |

The files are byte-for-byte upstream. `source.test.mjs` checks the sha256.

Upstream fields used: `id`, `commune_name` (AR), `commune_name_fr`, `wilaya_code`, `wilaya_name`,
`wilaya_name_fr`. Not used: `daira_*`, `Lat`, `Long`, and `code_commune` (pre-reform ONS codes, see
`corrections.json` rules).

## jo/ — Journal officiel evidence

`jo/official-lists.json` holds the commune lists of the 38 wilayas whose composition is printed in
Law 26-06 (2026) or Law 19-12 (2019), each mapped to an upstream row id. See `jo/README.md`.

## corrections.json

Every change applied on top of upstream: 50 commune moves (to match the JO), 20 commune name fixes,
13 wilaya name fixes, plus mechanical rules (hyphens, whitespace). Reasoning and sources:
`artifacts/GEO-1/decision.md` and `DECISIONS.md`.

## Tests

`node --test 'data/geo/**/*.test.mjs'`
