/**
 * Types for the vendoring script, so `map-vendor.test.ts` can import the paths it
 * writes rather than restating them. The script itself stays plain Node with no
 * build step, which is what lets `prebuild` run it before anything is compiled.
 */
export declare const VENDORED_FILES: string[];
export declare const VENDOR_DIR: string;
export declare const VENDOR_PUBLIC_PATH: string;
export declare function vendorMaplibre(options?: { quiet?: boolean }): string;
