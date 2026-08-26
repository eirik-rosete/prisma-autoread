// ═══ Engine (v1) ═══════════════════════════════════════════════════════════════

// Entry point.
export { createAutoRead, AutoReadEndpoint } from './auto-read';

// Configuration.
export { OptionsResolver } from './config/options-resolver';
export { Keywords } from './config/keywords';
export { ProviderDetector } from './config/provider';

// Core.
export { QueryBuilder } from './core/query-builder';
export { Executor } from './core/executor';
export { OperatorRegistry } from './core/operators';
export { FieldMask } from './core/mask';
export { SpecGuard } from './core/spec-guard';
export { PlanCache } from './core/cache';
export { RecommendationEngine } from './core/recommendations';
export { DmmfRegistry, ModelMeta } from './core/dmmf/registry';
export { ValueCoercer } from './core/dmmf/coercer';

// Input.
export { InputRegistry } from './input/input-registry';
export { QueryControlsParser } from './input/query-controls';
export { QueryBracketsAdapter } from './input/query-brackets.adapter';
export { JsonBodyAdapter } from './input/json-body.adapter';
export { LegacyAdapter } from './input/legacy.adapter';
export { RsqlAdapter } from './input/rsql.adapter';
export { ODataAdapter } from './input/odata.adapter';
export { RsqlParser } from './input/parsers/rsql-parser';
export { ODataParser } from './input/parsers/odata-parser';

// Output.
export { OutputRegistry } from './output/output-registry';
export { HalOutput } from './output/hal.adapter';
export { PlainOutput } from './output/plain.adapter';
export { JsonApiOutput } from './output/jsonapi.adapter';
export { CsvOutput } from './output/csv.adapter';
export { Serializer } from './output/serializer';
export { LinkBuilder } from './output/link-builder';

// Routes.
export { Route } from './routes/route';
export { RouteRegistry } from './routes/route-registry';
export { ListRoute } from './routes/list.route';
export { CountRoute } from './routes/count.route';
export { AggregateRoute } from './routes/aggregate.route';
export { GroupByRoute } from './routes/group-by.route';
export type { RouteExecutionContext, RouteResult } from './routes/route';

// HTTP.
export { EndpointController } from './http/endpoint-controller';
export { ExpressBinding } from './http/express.binding';
export { FastifyBinding } from './http/fastify.binding';
export { HonoBinding } from './http/hono.binding';

// Errors.
export { NotImplementedError } from './errors';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
    QuerySpec,
    RawSpec,
    RequestInput,
    QueryResult,
    BuildContext,
    EngineDefaults,
    ResolvedSecurity,
    AggregationSpec,
    SortDir,
    JsonPathSyntax,
    MaskNode,
} from './types/query';
export type {
    AutoReadOptions,
    ResolvedOptions,
    ResolvedRoute,
    RouteName,
    RouteConfig,
    RoutesOption,
    SecurityOptions,
    QueryTelemetry,
} from './types/options';
export type { InputAdapter, AdapterContext, OutputAdapter, OutputContext } from './types/adapters';
export type { FieldMeta, RelationMeta, CompositeMeta, ModelMetadata } from './types/dmmf';
export type { KeywordMap, KeywordOverrides } from './types/keywords';
export type { Recommendation, RecommendationLevel } from './types/recommendations';
export type { PrismaDelegate, FindByFilter, ExecutorSource, DatasourceProvider, RelationLoadStrategy } from './types/prisma';
export type {
    HttpRequestContext,
    HttpResponsePayload,
    ExpressRouterLike,
    FastifyLike,
    HonoLike,
} from './types/http';

// ═══ Legacy engine (frozen, backward-compatible) ═══════════════════════════════

export { default as AutoReadMiddleware } from './legacy/auto-read.middleware';
export { default as FilterMiddleware } from './legacy/filter.middleware';
export { default as PaginationMiddleware } from './legacy/pagination.middleware';

export { default as FilterValidator } from './legacy/utils/filter-validator.util';
export { default as FilterValueParser } from './legacy/utils/filter-value-parser.util';
export { default as IncludeParser } from './legacy/utils/include-parser.util';
export { default as NestedRelationProcessor } from './legacy/utils/nested-relation-processor.util';
export { default as JsonFilterProcessor } from './legacy/utils/json-filter-processor.util';
export { default as ConditionParser } from './legacy/utils/condition-parser.util';
export { default as CompositeWhereNormalizer } from './legacy/utils/composite-where.util';

export type {
    AutoReadConfig,
    CustomRequestData,
    FilterGroup,
    JsonFilter,
    LikeFilter,
    LikeFilterMode,
    PaginationData,
    PrismaQueryArgs,
    RequestFilterable,
} from './types';
export type { ParsedConditions } from './legacy/utils/condition-parser.util';

// ─── Utils ────────────────────────────────────────────────────────────────────
export { obtainUrl } from './utils/url.utils';
