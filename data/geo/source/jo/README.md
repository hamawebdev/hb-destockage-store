# Journal officiel sources (JORADP)

| Text | JO | Pages | PDF (sha256 of the file downloaded 2026-11-04) |
|---|---|---|---|
| **Law 26-06** of 4 April 2026, amending and completing Law 84-09 (territorial organisation): 69 wilayas, 1,541 communes; rewrites the lists of 10 wilayas; creates arts. 52 bis 10–20 (the 11 new wilayas) | n°25, 5 April 2026 | FR 4–9, AR 4–11 | FR https://www.joradp.dz/FTP/jo-francais/2026/F2026025.pdf `f6d7f526…e46f`; AR https://www.joradp.dz/FTP/jo-arabe/2026/A2026025.pdf `e2176036…8e87` |
| **Presidential Decree 26-206** of 25 May 2026, completing Decree 84-79 (names and chefs-lieux of wilayas): items 59–69 | n°40, 3 June 2026 | FR 5, AR 6 | FR https://www.joradp.dz/FTP/jo-francais/2026/F2026040.pdf `7cc0cf26…b9b0`; AR https://www.joradp.dz/FTP/jo-arabe/2026/A2026040.pdf `a4552b3a…ab3f` |
| Executive Decree 26-208 of 26 May 2026 (split of assets between mother and new wilayas; deadline 31 Dec 2026) | n°40, 3 June 2026 | FR 6 | same PDF |
| **Law 84-09** of 4 February 1984 (territorial organisation): 48 wilayas, 1,540 communes; art. 5–52 list each wilaya (art. = code + 4). Scan, no text layer: transcribed by hand (GEO-6) | n°6, 7 Feb 1984 | FR 101–111 | https://www.joradp.dz/FTP/jo-francais/1984/F1984006.pdf `d14ebe0f…ab3ff` |
| **Ordinance 97-14** of 31 May 1997 (territorial organisation of the wilaya of Alger): moves 6 communes of Boumerdès, 14 of Tipaza and 4 of Blida to Alger. Scan, read by hand | n°38, 4 Jun 1997 | FR 4–5 | https://www.joradp.dz/FTP/jo-francais/1997/F1997038.pdf (sha256 in `law-84-09-1984.json`) |
| **Law 19-12** of 11 December 2019, amending Law 84-09: 58 wilayas, 1,541 communes; rewrites 8 wilaya lists; creates arts. 52 bis–52 bis 9 (wilayas 49–58) | n°78, 18 Dec 2019 | FR 12–15, AR 13–16 | FR https://www.joradp.dz/FTP/jo-francais/2019/F2019078.pdf `5a311597…669d`; AR https://www.joradp.dz/FTP/jo-arabe/2019/A2019078.pdf `4a135bc5…4054` |

Full hashes are in `official-lists.json` → `sources`. The PDFs are not committed (about 2 MB); re-download
them from the URLs and compare the hashes.

## What `official-lists.json` covers

- 21 lists from Law 26-06: the 10 rewritten wilayas (3, 5, 7, 12, 13, 14, 17, 26, 28, 32) and the 11 new ones (59–69).
- 17 lists from Law 19-12 that 26-06 did not rewrite: 1, 8, 11, 30, 33, 39, 47 and 49–58. Biskra (7) is
  taken from 26-06 because it was rewritten again in 2026.
- Total 539 communes. Each list's length equals the count written in its article.
- Law 84-09 numbers the wilaya articles `code + 4` (art. 7 = Laghouat, code 3), which ties each rewritten
  article to its wilaya code.
- The other **31 wilayas (1,002 communes)** keep their 1984 composition (Law 84-09, JO 1984 n°6), except for Ordinance 97-14 (JO 1997 n°38), which moved 24 communes from Boumerdès, Tipaza and Blida to Alger. Both PDFs are scans without a text layer. Their lists are transcribed by hand in `law-84-09-1984.json` (GEO-6) and mapped to upstream ids, so all 1,541 communes are tied to a JO list. Per-wilaya results: `artifacts/GEO-6/report.md`.

## How it was extracted

1. `pdftotext` (poppler) per page and per column (`-x 0|298 -y 0 -W 298 -H 842`, A4 two-column layout).
2. Parse the numbered items under each "Art. N. — Les (n) communes suivantes constituent une wilaya".
   The Arabic edition has the same order. Eastern Arabic digits were converted, NFKC applied and tatweel removed.
3. Check that every list length equals its declared count (all 38 match).
4. Map each JO item to an upstream row inside its "family" (a parent wilaya plus the wilayas carved from it). Matching passes, in order: French and Arabic exact after normalisation; Arabic only; French only; French consonant skeleton; then a manually reviewed edit-distance match for 8 items, listed in `artifacts/GEO-1/decision.md`.

**Arabic caveat.** The Arabic PDF text layer has ligature artifacts. One was fixed (اجملبارة → المجبارة), and
some are suspected (for example «سيد عبد اللى» for Sidi Abdelli). Final ى is printed for ي in several names (سيدى, بنى). So the
`ar` strings here are evidence for matching, **not display data**. Display Arabic names come from
upstream unless `corrections.json` overrides them. The French text layer is clean.
