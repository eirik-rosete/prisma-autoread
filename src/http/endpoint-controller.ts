import { Executor } from '../core/executor';
import { DmmfRegistry } from '../core/dmmf/registry';
import { RouteRegistry } from '../routes/route-registry';
import { RecommendationEngine } from '../core/recommendations';
import { NotImplementedError } from '../errors';
import type { HttpRequestContext, HttpResponsePayload } from '../types/http';
import type { RequestInput, QuerySpec } from '../types/query';
import type { ResolvedOptions, ResolvedRoute } from '../types/options';

/**
 * Framework-agnostic request pipeline.
 *
 * It owns the whole flow — resolve input adapter → build the query plan (with an
 * optional cache) → execute the route → render the output — and returns a plain
 * `{ status, body, contentType }`. Every framework binding is a thin translation
 * layer on top of this class.
 */
export class EndpointController {
    private readonly executor: Executor;
    private readonly routes = new RouteRegistry();

    constructor(private readonly options: ResolvedOptions) {
        this.executor = new Executor(options.source);
    }

    /** Whether this endpoint answers the given HTTP method. */
    handles(method: string): boolean {
        return this.options.methods.includes(method.toUpperCase());
    }

    async handle(route: ResolvedRoute, request: HttpRequestContext): Promise<HttpResponsePayload> {
        const started = Date.now();
        const method = request.method.toUpperCase();
        const model = DmmfRegistry.model(this.options.model);

        const input: RequestInput = {
            method,
            query: request.query ?? {},
            body: request.body,
        };

        const { spec, cacheHit } = await this.plan(input, route, model);
        const parseMs = Date.now() - started;

        const format = this.negotiate(request);
        const execStarted = Date.now();

        const take = spec.take ?? this.options.defaults.limit;
        const page = take > 0 ? Math.floor((spec.skip ?? 0) / take) + 1 : 1;

        const result = await this.routes.get(route.name).execute(spec, {
            executor: this.executor,
            output: this.options.output,
            outputFormat: format,
            keywords: this.options.keywords,
            resource: this.options.model,
            idField: model.field('id')?.name,
            page,
            limit: take,
            baseUrl: request.baseUrl + request.path,
            query: input.query,
            hidden: this.options.security.hidden,
        });

        this.options.onQuery?.({
            route: route.name,
            format,
            method,
            parseMs,
            execMs: Date.now() - execStarted,
            cacheHit,
            estimatedRows: spec.estimatedRows,
        });

        if (this.options.onRecommendation) {
            const recommendations = RecommendationEngine.analyze(
                spec, this.options.model, this.options.security, this.options.provider,
            );
            for (const recommendation of recommendations) this.options.onRecommendation(recommendation);
        }

        return { status: 200, body: result.body, contentType: result.contentType };
    }

    // ── internals ─────────────────────────────────────────────────────────────

    /** Build (or reuse) the query plan for this request. */
    private async plan(
        input: RequestInput,
        route: ResolvedRoute,
        model: ReturnType<typeof DmmfRegistry.model>,
    ): Promise<{ spec: QuerySpec; cacheHit: boolean }> {
        const key = this.options.cache ? EndpointController.signature(input, route.path) : undefined;
        const cached = key ? this.options.cache!.get(key) : undefined;
        if (cached) return { spec: cached, cacheHit: true };

        const adapter = this.options.input.resolve(input, this.options.keywords);
        if (!adapter) throw new NotImplementedError(`input adapter for method ${input.method}`);

        const spec = await adapter.parse(input, {
            model,
            keywords: this.options.keywords,
            build: {
                defaults: this.options.defaults,
                searchable: this.options.searchable,
                security: this.options.security,
                jsonPathSyntax: this.options.jsonPathSyntax,
            },
        });

        if (key) this.options.cache!.set(key, spec);
        return { spec, cacheHit: false };
    }

    /** Pick the output format: the format keyword wins, then `Accept`, then the default. */
    private negotiate(request: HttpRequestContext): string {
        const requested = request.query?.[this.options.keywords.format];
        if (typeof requested === 'string' && this.options.output.has(requested)) return requested;

        const accept = String(request.headers?.accept ?? '');
        for (const [mime, format] of EndpointController.ACCEPT_FORMATS) {
            if (accept.includes(mime) && this.options.output.has(format)) return format;
        }
        return this.options.outputFormat;
    }

    private static readonly ACCEPT_FORMATS: ReadonlyArray<readonly [string, string]> = [
        ['application/vnd.api+json', 'jsonapi'],
        ['text/csv', 'csv'],
        ['application/hal+json', 'hal'],
    ];

    /** Cache key: method + route path + query + body. */
    private static signature(input: RequestInput, path: string): string {
        return `${input.method} ${path} ${JSON.stringify(input.query)} ${JSON.stringify(input.body ?? null)}`;
    }
}
