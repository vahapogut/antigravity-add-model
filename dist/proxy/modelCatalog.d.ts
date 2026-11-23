export interface CatalogIdentity {
    name: string;
    externalModelName?: string;
    displayName?: string;
}
export declare function legacyModelSlug(model: CatalogIdentity): string;
/** An always-available routing alias tied to the saved model, including its effort settings. */
export declare function localModelSlug(model: CatalogIdentity): string;
export declare function catalogModelSlug(model: CatalogIdentity, models: CatalogIdentity[]): string;
export declare function matchesModelSlug(model: CatalogIdentity, value: string, models: CatalogIdentity[]): boolean;
export declare function fallbackModelDisplayName(model: CatalogIdentity): string;
/** The native IDE resolves sorted options by label, so display labels must also be unique. */
export declare function catalogDisplayNames(models: CatalogIdentity[], upstream?: unknown): Map<string, string>;
export interface CatalogEntry {
    slug: string;
    mapEntry: Record<string, unknown>;
    listEntry: Record<string, unknown>;
}
/** Preserve native metadata while advertising only configured custom models in every response shape. */
export declare function mergeCloudCodeCatalog(upstream: unknown, entries: CatalogEntry[]): Record<string, unknown>;
//# sourceMappingURL=modelCatalog.d.ts.map