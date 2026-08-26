/**
 * Query-model types. Declaration-only: no runtime code lives here.
 */

export type SortDir = 'asc' | 'desc';

/** How Prisma expects a JSON `path` to be expressed, per datasource. */
export type JsonPathSyntax = 'array' | 'string';

/** Aggregation selectors shared by the aggregate and group-by routes. */
export interface AggregationSpec {
    _count?: boolean | Record<string, true>;
    _sum?: Record<string, true>;
    _avg?: Record<string, true>;
    _min?: Record<string, true>;
    _max?: Record<string, true>;
}

/** Prisma-ready query, produced by adapters and run by the executor. */
export interface QuerySpec extends AggregationSpec {
    where?: Record<string, any>;
    orderBy?: Array<Record<string, SortDir>>;
    select?: Record<string, any>;
    include?: Record<string, any>;
    skip?: number;
    take?: number;
    /** Distinct fields (list route). */
    distinct?: string[];
    /** Cursor position for cursor pagination (list route). */
    cursor?: Record<string, any>;
    /** Group-by fields (group-by route). */
    by?: string[];
    /** Group-by `having` clause. */
    having?: Record<string, any>;
    /**
     * Best-effort estimate of the row count this plan can materialise: the root
     * `take` multiplied down every bounded to-many relation in `include`. Relations
     * left unbounded (no `security.maxRelationRows` configured, no explicit `take`)
     * are not counted, so this is a floor, not a hard ceiling. Metadata only — never
     * sent to Prisma.
     */
    estimatedRows?: number;
}

/**
 * Pre-validation shape produced by an adapter before the builder coerces,
 * validates and maps it to a {@link QuerySpec}. `where` here may use operator
 * aliases (`gte`, `contains`, …) and raw string values.
 */
export interface RawSpec {
    where?: Record<string, any>;
    orderBy?: Array<Record<string, SortDir>>;
    select?: Record<string, any>;
    include?: Record<string, any>;
    page?: number;
    limit?: number;
    skip?: number;
    take?: number;
    search?: string;
    distinct?: string | string[];
    cursor?: Record<string, any> | string | number;
    count?: boolean | string | string[];
    sum?: string | string[];
    avg?: string | string[];
    min?: string | string[];
    max?: string | string[];
    by?: string | string[];
    having?: Record<string, any>;
}

/** HTTP-agnostic view of the request, consumed by input adapters. */
export interface RequestInput {
    /** Upper-case HTTP method: `GET` | `QUERY` | `POST`. */
    method: string;
    /** Parsed query string (deep-object form). */
    query: Record<string, any>;
    /** Parsed JSON body (for `QUERY` / `POST`). */
    body?: any;
}

/** Default paging/sorting knobs resolved from config. */
export interface EngineDefaults {
    limit: number;
    maxLimit: number;
    sort: string;
    order: SortDir;
}

/**
 * One level of the compiled `security.hidden` tree: the names hidden here, plus
 * the sub-trees that apply inside a relation or composite field.
 */
export interface MaskNode {
    /** Lower-cased names hidden at this level. */
    fields: Set<string>;
    /** Lower-cased relation/composite name → mask that applies inside it. */
    children: Map<string, MaskNode>;
}

/** Normalised access control applied while building the query. */
export interface ResolvedSecurity {
    /** `'*'` = any field; otherwise a set of allowed field names (lower-cased). */
    fields: '*' | Set<string>;
    /** `'*'` = any relation; otherwise a set of allowed relation names (lower-cased). */
    relations: '*' | Set<string>;
    /** Compiled allow-nothing mask: fields never queryable **and** never returned. */
    hidden?: MaskNode;
    /** Maximum filter/include nesting depth. */
    maxDepth: number;
    /** Maximum size of an `in`/`notIn` list before it is rejected with `400`. Defaults to 1000. */
    maxInValues?: number;
    /** Maximum number of branches in an `OR`/`AND` array before it is rejected with `400`. Defaults to 50. */
    maxOrBranches?: number;
    /**
     * Ceiling (and, when a to-many relation's `include` omits `take`, the
     * auto-injected default) for rows fetched per relation. `undefined` leaves
     * nested collections exactly as before: unbounded unless the client passes an
     * explicit `take`.
     */
    maxRelationRows?: number;
    /**
     * Ceiling on the estimated total row count of an `include` tree (root `take`
     * multiplied down every bounded to-many relation). Only chains where every
     * level's row count is known (explicit `take`, or the auto-injected default
     * from `maxRelationRows`) are counted. Defaults to 5000.
     */
    maxFanout?: number;
}

/** Everything the builder needs beyond the model metadata. */
export interface BuildContext {
    defaults: EngineDefaults;
    /** Fields scanned by the search keyword. */
    searchable: string[];
    /** Optional access control; when omitted, everything is allowed. */
    security?: ResolvedSecurity;
    /** JSON `path` format to normalise to. Defaults to `'array'`. */
    jsonPathSyntax?: JsonPathSyntax;
}

/** Result of a list execution. */
export interface QueryResult<T = any> {
    data: T[];
    total: number;
}
