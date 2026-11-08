/** Fold a name or a query: lower-case, no diacritics/tashkeel, alef/hamza/ya/ta-marbuta folded, ASCII digits, punctuation → single spaces. Never drops or rewrites a word. */
export declare function normalizeForSearch(s: string, lang?: 'ar' | 'fr'): string;
/** Index key for a name: folded form plus spelling alternatives joined by "|". Match with `searchKey(name).includes(normalizeForSearch(query))`. */
export declare function searchKey(name: string, lang?: 'ar' | 'fr'): string;
