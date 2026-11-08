export type GeoLang = 'ar' | 'fr';
/** Same shape as WilayaOption in packages/catalog: label = `<code> - <name>`. */
export interface GeoWilayaOption {
  readonly code: number;
  readonly label: string;
}
/** One commune in a per-wilaya file: [communeId, name in the file's language]. */
export type GeoCommuneEntry = [id: number, name: string];
export declare const LANGS: readonly ['ar', 'fr'];
/** Path relative to the site root, e.g. `geo/communes/ar/16.json`. */
export declare function communesFile(lang: GeoLang, code: number): string;
export declare function geoAssets(lang: GeoLang): {
  wilayas: GeoWilayaOption[];
  communes: { code: number; list: GeoCommuneEntry[] }[];
};
/** Writes `<outDir>/geo/communes/<lang>/<code>.json` for codes 1–69; returns the wilaya options (code order) and the files written (relative to outDir). */
export declare function buildGeoAssets(outDir: string, opts: { lang: GeoLang }): Promise<{ wilayas: GeoWilayaOption[]; files: string[] }>;
