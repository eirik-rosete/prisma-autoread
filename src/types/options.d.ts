import type { InputRegistry } from '../input/input-registry';
import type { OutputRegistry } from '../output/output-registry';
import type { PlanCache } from '../core/cache';
import type { EngineDefaults, ResolvedSecurity, QuerySpec, JsonPathSyntax } from './query';
import type { PrismaDelegate, FindByFilter, ExecutorSource, DatasourceProvider, RelationLoadStrategy } from './prisma';
import type { KeywordMap, KeywordOverrides } from './keywords';
import type { Recommendation } from './recommendations';

export type RouteName = 'list' | 'count' | 'aggregate' | 'groupBy';

/** Per-route customisation. */
export interface RouteConfig {
    path?: string;
}

/**
 * Which routes to expose. Short form `['list', 'count']` uses default paths;
 * the map form lets you override each path: `{ count: { path: '/total' } }`.
 */
export type RoutesOption = RouteName[] | Partial<Record<RouteName, boolean | RouteConfig>>;

/** Access-control knobs for the generated endpoint. */
export interface SecurityOptions {
    /**
     * Deny by default. When `true`, `fields` (and `relations`, if the model has any
     * you intend to expose) must be explicit allow-lists — `'*'` is rejected.
     */
    strict?: boolean;
    /** Allowed filter/sort/select fields (`'*'` = all). */
    fields?: '*' | string[];
    /** Allowed relations to traverse/include (`'*'` = all). */
    relations?: '*' | string[];
    /**
     * Fields that must never leave the server. Unlike `fields`, which only limits
     * what a client may *ask for*, a hidden field is stripped from every response —
     * including rows fetched through `include`, wildcards or embedded documents —
     * and is rejected (as if it did not exist) in filters, sorts, `fields`,
     * `distinct`, aggregations and `group-by`.
     *
     * Dotted paths reach into relations and MongoDB composite types, and matching
     * is case-insensitive: `['password', 'enrolments.token', 'program.uuid']`.
     */
    hidden?: string[];
    /** Maximum filter/include nesting depth (default 12). */
    maxDepth?: number;
    /** Maximum size of an `in`/`notIn` list (default 1000). */
    maxInValues?: number;
    /** Maximum number of `OR`/`AND` branches (default 50). */
    maxOrBranches?: number;
    /**
     * Row budget for `include`, the single biggest lever against runaway nested
     * reads: caps `take` on every to-many relation in `include`, and — this is the
     * important part — auto-injects that cap when the client's `include` omits
     * `take` altogether, so a to-many relation can no longer come back unbounded.
     *
     * Unset (the default) changes nothing: nested collections stay exactly as
     * today, unbounded unless the client passes an explicit `take`. Set it once you
     * are ready for that default to change — e.g. `maxRelationRows: 100`.
     */
    maxRelationRows?: number;
    /**
     * Ceiling on the estimated size of an `include` tree — root `take` multiplied
     * down every to-many relation whose row count is known (explicit `take`, or the
     * `maxRelationRows` default). Default `5000`; only bites once a request's own
     * numbers multiply past it, so it does not require `maxRelationRows` to be set.
     */
    maxFanout?: number;
}

/** Timing/telemetry passed to the optional `onQuery` hook. */
export interface QueryTelemetry {
    route: RouteName;
    format: string;
    method: string;
    /** Milliseconds spent parsing/validating the request into a query plan. */
    parseMs: number;
    /** Milliseconds spent executing against the database. */
    execMs: number;
    /** Whether the query plan came from the cache. */
    cacheHit: boolean;
    /**
     * Best-effort estimate of rows this plan can materialise (see
     * {@link QuerySpec.estimatedRows}). `undefined` for routes without a plan
     * (nothing was built, or the route has no `include`).
     */
    estimatedRows?: number;
}

/** Public configuration accepted by `createAutoRead`. */
export interface AutoReadOptions {
    /** Prisma model name (schema casing, e.g. `'User'`). */
    model: string;
    /** Prisma model delegate (`prisma.user`). Enables every route. */
    delegate?: PrismaDelegate;
    /** Legacy-style callback, as an alternative to `delegate`. */
    findByFilter?: FindByFilter;
    /** HTTP methods to expose. Default `['GET']`. */
    methods?: string[];
    /** Routes to generate. Default `['list']`. */
    routes?: RoutesOption;
    /** Output format name. Default `'hal'`. */
    output?: string;
    /** Accept the old GET query syntax (via the legacy engine). Default `true`. */
    legacy?: boolean;
    /** GET dialects to accept when `legacy` is false. Default `['query','rsql','odata']`. */
    formats?: Array<'query' | 'rsql' | 'odata'>;
    /** Fields scanned by the search keyword. */
    searchable?: string[];
    /** Pagination/sort defaults. */
    defaults?: Partial<EngineDefaults>;
    /** Access control. */
    security?: SecurityOptions;
    /** Prefix inserted into generated links (e.g. `'/api/v1'`). */
    basePathPrefix?: string;
    /** Cache parsed query plans by request signature. `true` uses a 500-entry LRU. */
    cache?: boolean | { max?: number };
    /** Telemetry hook invoked after each request with timing info. */
    onQuery?: (telemetry: QueryTelemetry) => void;
    /**
     * Query-shape advisory hook — computed per request, from that request's own
     * plan and this endpoint's `security` config only (no database statistics, no
     * state kept between requests). Unset by default: nothing is computed unless
     * you provide it, and nothing here ever reaches the HTTP response.
     */
    onRecommendation?: (recommendation: Recommendation) => void;
    /** Rename reserved query parameters for this endpoint only. */
    keywords?: KeywordOverrides;
    /**
     * Datasource provider, used to pick the JSON `path` syntax. Auto-detected from
     * the Prisma client when possible; falls back to `'array'`.
     */
    provider?: DatasourceProvider | string;
    /** Force the JSON `path` syntax, bypassing provider detection. */
    jsonPathSyntax?: JsonPathSyntax;
    /**
     * Forwarded to Prisma's `findMany` whenever `include` is used. Prisma already
     * batches relation loads with a second `WHERE IN` query by default — this only
     * matters if your schema has `previewFeatures = ["relationJoins"]` enabled and
     * you want to pin the strategy explicitly (`'query'` keeps the batched
     * behaviour, `'join'` opts into a single SQL join). Leave unset otherwise:
     * without the preview feature, Prisma rejects the argument outright.
     */
    relationLoadStrategy?: RelationLoadStrategy;
}

export interface ResolvedRoute {
    name: RouteName;
    path: string;
}

/** Fully-normalised options consumed by the HTTP layer. */
export interface ResolvedOptions {
    model: string;
    source: ExecutorSource;
    input: InputRegistry;
    output: OutputRegistry;
    outputFormat: string;
    methods: string[];
    routes: ResolvedRoute[];
    defaults: EngineDefaults;
    searchable: string[];
    security: ResolvedSecurity;
    keywords: KeywordMap;
    jsonPathSyntax: JsonPathSyntax;
    basePathPrefix?: string;
    cache?: PlanCache<QuerySpec>;
    onQuery?: (telemetry: QueryTelemetry) => void;
    onRecommendation?: (recommendation: Recommendation) => void;
    /** Best-effort datasource provider (`'postgresql'`, `'mongodb'`, …), used to phrase index hints. */
    provider?: string;
}
