export interface Wilaya {
  /** Official code 1–69 (Decree 84-79 as completed; 59–69 from Decree 26-206). */
  readonly code: number;
  readonly name_ar: string;
  readonly name_fr: string;
}
export interface Commune {
  /** Stable id (upstream Algeria-Cities row id, pinned in data/geo/source). */
  readonly id: number;
  readonly wilaya_code: number;
  readonly name_ar: string;
  readonly name_fr: string;
  /** Not available in the source; never set today. */
  readonly postal_code?: string;
}
export declare function loadWilayas(): Wilaya[];
export declare function loadCommunes(): Commune[];
