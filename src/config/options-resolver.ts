import { InputRegistry } from '../input/input-registry';
import { QueryBracketsAdapter } from '../input/query-brackets.adapter';
import { JsonBodyAdapter } from '../input/json-body.adapter';
import { LegacyAdapter } from '../input/legacy.adapter';
import { RsqlAdapter } from '../input/rsql.adapter';
import { ODataAdapter } from '../input/odata.adapter';
import { OutputRegistry } from '../output/output-registry';
import { HalOutput } from '../output/hal.adapter';
import { PlainOutput } from '../output/plain.adapter';
import { JsonApiOutput } from '../output/jsonapi.adapter';
import { CsvOutput } from '../output/csv.adapter';
import { PlanCache } from '../core/cache';
import { FieldMask } from '../core/mask';
import { Keywords } from './keywords';
import { ProviderDetector } from './provider';
import type {
    AutoReadOptions,
    ResolvedOptions,
    ResolvedRoute,
    RouteName,
    RouteConfig,
    RoutesOption,
    SecurityOptions,
} from '../types/options';
import type { EngineDefaults, ResolvedSecurity, QuerySpec } from '../types/query';

/** Validates and normalises {@link AutoReadOptions} into {@link ResolvedOptions}. */
export class OptionsResolver {
    private static readonly DEFAULT_PATHS: Readonly<Record<RouteName, string>> = Object.freeze({
        list: '/',
        count: '/count',
        aggregate: '/aggregate',
        groupBy: '/group-by',
    });

    static resolve(options: AutoReadOptions): ResolvedOptions {
        if (!options.model) throw new Error('createAutoRead: `model` is required');
        if (!options.delegate && !options.findByFilter) {
            throw new Error('createAutoRead: provide `delegate` (e.g. prisma.user) or `findByFilter`');
        }

        const methods = (options.methods ?? ['GET']).map(method => method.toUpperCase());
        const legacy = options.legacy ?? true;
        const security = OptionsResolver.buildSecurity(options.security);
        // A hidden column must not be reachable through `?search=` either.
        const searchable = FieldMask.visible(options.searchable ?? [], security.hidden);
        const keywords = Keywords.resolve(options.keywords);

        return {
            model: options.model,
            source: {
                delegate: options.delegate,
                finder: options.findByFilter,
                relationLoadStrategy: options.relationLoadStrategy,
            },
            input: OptionsResolver.buildInput(options, methods, legacy, searchable),
            output: OptionsResolver.buildOutput(),
            outputFormat: options.output ?? 'hal',
            methods,
            routes: OptionsResolver.buildRoutes(options.routes ?? ['list']),
            defaults: OptionsResolver.buildDefaults(options.defaults),
            searchable,
            security,
            keywords,
            jsonPathSyntax: ProviderDetector.resolve({
                jsonPathSyntax: options.jsonPathSyntax,
                provider: options.provider,
                delegate: options.delegate,
            }),
            basePathPrefix: options.basePathPrefix,
            cache: options.cache
                ? new PlanCache<QuerySpec>(
                    typeof options.cache === 'object' ? options.cache.max : undefined,
                )
                : undefined,
            onQuery: options.onQuery,
            onRecommendation: options.onRecommendation,
            provider: options.provider ?? ProviderDetector.detect(options.delegate),
        };
    }

    // ── sections ──────────────────────────────────────────────────────────────

    private static buildInput(
        options: AutoReadOptions,
        methods: string[],
        legacy: boolean,
        searchable: string[],
    ): InputRegistry {
        const input = new InputRegistry();

        if (methods.includes('GET')) {
            if (legacy) {
                input.register(new LegacyAdapter({ modelName: options.model, searchableFields: searchable }));
            } else {
                // Modern GET dialects disambiguate by parameter shape; the specific ones
                // (rsql: string filter, odata: $filter) go before the `query` catch-all.
                const formats = options.formats ?? ['query', 'rsql', 'odata'];
                if (formats.includes('rsql')) input.register(new RsqlAdapter());
                if (formats.includes('odata')) input.register(new ODataAdapter());
                if (formats.includes('query')) input.register(new QueryBracketsAdapter());
            }
        }
        if (methods.includes('QUERY') || methods.includes('POST')) {
            input.register(new JsonBodyAdapter());
        }

        return input;
    }

    private static buildOutput(): OutputRegistry {
        return new OutputRegistry()
            .register(new HalOutput())
            .register(new PlainOutput())
            .register(new JsonApiOutput())
            .register(new CsvOutput());
    }

    private static buildRoutes(routes: RoutesOption): ResolvedRoute[] {
        if (Array.isArray(routes)) {
            return routes.map(name => ({ name, path: OptionsResolver.DEFAULT_PATHS[name] }));
        }

        const resolved: ResolvedRoute[] = [];
        for (const [name, config] of Object.entries(routes) as Array<[RouteName, boolean | RouteConfig]>) {
            if (!config) continue;
            const path = config === true
                ? OptionsResolver.DEFAULT_PATHS[name]
                : (config.path ?? OptionsResolver.DEFAULT_PATHS[name]);
            resolved.push({ name, path });
        }
        return resolved;
    }

    private static buildDefaults(defaults?: Partial<EngineDefaults>): EngineDefaults {
        return {
            limit: defaults?.limit ?? 10,
            maxLimit: defaults?.maxLimit ?? 100,
            sort: defaults?.sort ?? 'id',
            order: defaults?.order ?? 'asc',
        };
    }

    /**
     * In strict mode nothing is exposed unless it is listed, and a wildcard is
     * rejected outright so the deny-by-default intent cannot be bypassed silently.
     */
    private static buildSecurity(security?: SecurityOptions): ResolvedSecurity {
        const hidden = FieldMask.compile(security?.hidden);

        if (security?.strict) {
            if (!Array.isArray(security.fields) || security.fields.length === 0) {
                throw new Error(
                    'createAutoRead: `security.strict` requires an explicit `security.fields` allow-list',
                );
            }
            if (security.relations === '*') {
                throw new Error(
                    'createAutoRead: `security.strict` does not allow `security.relations: "*"`',
                );
            }
            return {
                fields: OptionsResolver.toSet(security.fields),
                relations: OptionsResolver.toSet(security.relations ?? []),
                hidden,
                maxDepth: security.maxDepth ?? 12,
                maxInValues: security.maxInValues ?? 1000,
                maxOrBranches: security.maxOrBranches ?? 50,
                maxRelationRows: security.maxRelationRows,
                maxFanout: security.maxFanout ?? 5000,
            };
        }

        return {
            fields: OptionsResolver.toSet(security?.fields),
            relations: OptionsResolver.toSet(security?.relations),
            hidden,
            maxDepth: security?.maxDepth ?? 12,
            maxInValues: security?.maxInValues ?? 1000,
            maxOrBranches: security?.maxOrBranches ?? 50,
            maxRelationRows: security?.maxRelationRows,
            maxFanout: security?.maxFanout ?? 5000,
        };
    }

    private static toSet(value?: '*' | string[]): '*' | Set<string> {
        if (!value || value === '*') return '*';
        return new Set(value.map(item => item.toLowerCase()));
    }
}
