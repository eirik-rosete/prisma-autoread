/**
 * Query-shape advisories, computed per request from the already-built
 * {@link QuerySpec} plus the endpoint's own `security` config — never from
 * database statistics, and never persisted between requests.
 */

export type RecommendationLevel = 'info' | 'warn';

/** One finding surfaced by {@link RecommendationEngine.analyze}. */
export interface Recommendation {
    level: RecommendationLevel;
    /** Stable machine-readable slug, e.g. `'unbounded-relation'`. */
    code: string;
    /** Human-readable explanation of what was found. */
    message: string;
    /** Model the finding is about. */
    model: string;
    /** Field or relation name, when the finding is about one. */
    field?: string;
    /** Suggested next step — a config change, or an index to evaluate. */
    hint?: string;
}
