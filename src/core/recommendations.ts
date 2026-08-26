import { DmmfRegistry } from './dmmf/registry';
import type { QuerySpec, ResolvedSecurity } from '../types/query';
import type { Recommendation } from '../types/recommendations';

/** Providers whose indexes are expressed as `CREATE INDEX` — everyone but MongoDB. */
const SQL_PROVIDER = (provider?: string): boolean => !!provider && provider.toLowerCase() !== 'mongodb';

/** Fraction of a budget at which a "you're getting close" note fires, ahead of the hard `400`. */
const NEAR_BUDGET_RATIO = 0.7;

/**
 * Stateless, per-request advisor over an already-built {@link QuerySpec}.
 *
 * Every finding is derived from this one request's plan and the endpoint's own
 * `security` config — nothing is measured against the database (no `EXPLAIN`, no
 * table statistics) and nothing is remembered between requests. That keeps it
 * cheap enough to run on every request and free of the staleness/memory-growth
 * concerns a cross-request aggregate would carry.
 *
 * Wired to `AutoReadOptions.onRecommendation`; computed only when that hook is set.
 */
export class RecommendationEngine {
    static analyze(
        spec: QuerySpec,
        model: string,
        security: ResolvedSecurity,
        provider: string | undefined,
    ): Recommendation[] {
        const out: Recommendation[] = [];

        if (spec.include) {
            RecommendationEngine.walkInclude(spec.include, model, security, out, []);
        }
        RecommendationEngine.fanout(spec, model, security, out);
        if (spec.where) {
            RecommendationEngine.walkWhere(spec.where, model, security, out, new Set());
        }
        RecommendationEngine.deepOffset(spec, model, out);
        RecommendationEngine.indexHint(spec, model, provider, out);

        return out;
    }

    // ── include tree ────────────────────────────────────────────────────────────

    private static walkInclude(
        include: Record<string, any>,
        modelName: string,
        security: ResolvedSecurity,
        out: Recommendation[],
        path: string[],
    ): void {
        const model = DmmfRegistry.model(modelName);
        for (const [key, value] of Object.entries(include)) {
            const relation = model.relation(key);
            if (!relation) continue; // composite field, or a name the builder already rejected

            const node = value === true ? {} : (value ?? {});
            const dotted = [...path, relation.name].join('.');

            // By default every to-many relation gets a `take` (see
            // QueryBuilder's `maxRelationRows` normalisation), so a node still
            // missing one here means `security.maxRelationRows` was explicitly
            // set to `Infinity` for this endpoint.
            if (relation.isList && node.take === undefined) {
                out.push({
                    level: 'warn',
                    code: 'unbounded-relation',
                    model: modelName,
                    field: relation.name,
                    message: `Relation '${dotted}' has no 'take': security.maxRelationRows must be set to Infinity here, so a single parent with many children can return the relation's every row.`,
                    hint: `Give security.maxRelationRows a finite value to restore a default ceiling on this relation, unless returning it in full is genuinely intended.`,
                });
            }

            if (node.include) {
                RecommendationEngine.walkInclude(node.include, relation.target, security, out, [...path, relation.name]);
            }
        }
    }

    private static fanout(spec: QuerySpec, model: string, security: ResolvedSecurity, out: Recommendation[]): void {
        if (spec.estimatedRows === undefined || !security.maxFanout) return;
        const ratio = spec.estimatedRows / security.maxFanout;
        if (ratio < NEAR_BUDGET_RATIO) return;
        out.push({
            level: 'info',
            code: 'fanout-near-budget',
            model,
            message: `This plan is estimated at ${Math.round(spec.estimatedRows)} rows (~${Math.round(ratio * 100)}% of the security.maxFanout=${security.maxFanout} budget).`,
            hint: 'Reduce the take of nested relations, or raise the budget if this size is intentional.',
        });
    }

    // ── where tree ───────────────────────────────────────────────────────────────

    private static readonly LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT']);

    private static walkWhere(
        node: any,
        model: string,
        security: ResolvedSecurity,
        out: Recommendation[],
        seenContainsFields: Set<string>,
    ): void {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (const item of node) RecommendationEngine.walkWhere(item, model, security, out, seenContainsFields);
            return;
        }

        for (const [key, value] of Object.entries(node)) {
            if (RecommendationEngine.LOGICAL_KEYS.has(key)) {
                const branches = Array.isArray(value) ? value : [value];
                if (key !== 'NOT' && security.maxOrBranches && branches.length >= Math.max(2, Math.floor(security.maxOrBranches * NEAR_BUDGET_RATIO))) {
                    out.push({
                        level: 'info',
                        code: 'many-logical-branches',
                        model,
                        message: `'${key}' combines ${branches.length} branches (limit security.maxOrBranches=${security.maxOrBranches}).`,
                        hint: 'Many OR/AND branches rarely use a single index; consider restructuring the filter if this pattern is common.',
                    });
                }
                RecommendationEngine.walkWhere(branches, model, security, out, seenContainsFields);
                continue;
            }

            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

            if (Array.isArray((value as any).in) && security.maxInValues) {
                const size = (value as any).in.length;
                if (size >= Math.max(10, Math.floor(security.maxInValues * 0.5))) {
                    out.push({
                        level: 'info',
                        code: 'large-in-list',
                        model,
                        field: key,
                        message: `Filter '${key}' uses 'in' with ${size} values (limit security.maxInValues=${security.maxInValues}).`,
                        hint: 'Very large lists stay costly even with an index; consider chunking (250-1000 per batch) or rethinking the filter.',
                    });
                }
            }

            if ('contains' in value && !seenContainsFields.has(key)) {
                seenContainsFields.add(key);
                out.push({
                    level: 'info',
                    code: 'unindexed-contains',
                    model,
                    field: key,
                    message: `Filter '${key}' uses 'contains' (equivalent to LIKE '%...%'), which typically cannot use a plain B-tree index.`,
                    hint: "If this search is frequent, consider a full-text index, or 'startsWith' where the use case allows it.",
                });
            }

            // Relation/composite filters nest a model-shaped object one level down
            // (`some`/`every`/`none`/`is`/`isNot`, or a bare filter); scalar operator
            // objects (`{ gte: 1 }`) have no further object values worth walking.
            for (const nested of Object.values(value)) {
                if (nested && typeof nested === 'object') {
                    RecommendationEngine.walkWhere(nested, model, security, out, seenContainsFields);
                }
            }
        }
    }

    // ── pagination / indexing ───────────────────────────────────────────────────

    private static readonly DEEP_OFFSET_THRESHOLD = 1000;

    private static deepOffset(spec: QuerySpec, model: string, out: Recommendation[]): void {
        if (spec.cursor !== undefined || spec.skip === undefined) return;
        if (spec.skip < RecommendationEngine.DEEP_OFFSET_THRESHOLD) return;
        out.push({
            level: 'info',
            code: 'deep-offset-pagination',
            model,
            message: `This page skips ${spec.skip} rows with 'skip'; a large OFFSET grows more expensive the further it reaches into the table.`,
            hint: 'For deep or infinite scrolling, use cursor pagination (cursor + take) instead of page/skip.',
        });
    }

    private static indexHint(
        spec: QuerySpec,
        model: string,
        provider: string | undefined,
        out: Recommendation[],
    ): void {
        if (!SQL_PROVIDER(provider)) return;

        const filterFields = RecommendationEngine.topLevelFields(spec.where);
        const orderFields = (spec.orderBy ?? []).map(entry => Object.keys(entry)[0]);
        const columns = [...filterFields];
        for (const field of orderFields) if (!columns.includes(field)) columns.push(field);
        if (columns.length < 2) return;

        const table = model.toLowerCase();
        const indexName = `idx_${table}_${columns.join('_').toLowerCase()}`;
        out.push({
            level: 'info',
            code: 'index-hint',
            model,
            message: `This query filters and/or sorts by: ${columns.join(', ')}.`,
            hint: `If this pattern is frequent, consider a composite index — adjust table/column names if you use @@map/@map: CREATE INDEX ${indexName} ON ${table} (${columns.join(', ')});`,
        });
    }

    /** Top-level scalar field names filtered on directly (skips AND/OR/NOT and nested relation/composite filters). */
    private static topLevelFields(where: Record<string, any> | undefined): string[] {
        if (!where) return [];
        return Object.keys(where).filter(key => !RecommendationEngine.LOGICAL_KEYS.has(key));
    }
}
