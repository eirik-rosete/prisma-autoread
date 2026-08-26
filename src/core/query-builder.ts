import { BadRequest } from '../errors';
import { DmmfRegistry, ModelMeta } from './dmmf/registry';
import { ValueCoercer } from './dmmf/coercer';
import { OperatorRegistry } from './operators';
import { FieldMask } from './mask';
import type { FieldMeta, RelationMeta, CompositeMeta } from '../types/dmmf';
import type {
    RawSpec,
    QuerySpec,
    BuildContext,
    SortDir,
    ResolvedSecurity,
    JsonPathSyntax,
    MaskNode,
} from '../types/query';

/** Nesting cap when no `security.maxDepth` is configured. */
const DEFAULT_MAX_DEPTH = 12;

/** Security defaults when the caller does not configure one at all (no `ctx.security`). */
const DEFAULT_SECURITY: ResolvedSecurity = {
    fields: '*',
    relations: '*',
    maxDepth: DEFAULT_MAX_DEPTH,
};

/** Budget defaults, applied in {@link QueryBuilder.build} regardless of where `security` came from. */
const DEFAULT_MAX_IN_VALUES = 1000;
const DEFAULT_MAX_OR_BRANCHES = 50;
const DEFAULT_MAX_FANOUT = 5000;

/** `ResolvedSecurity` with the budget fields defaulted, so the rest of the builder never sees `undefined`. */
type NormalizedSecurity = ResolvedSecurity & {
    maxInValues: number;
    maxOrBranches: number;
    maxFanout: number;
    /**
     * Always a concrete number: unset defaults to `ctx.defaults.limit`, so a
     * to-many relation is bounded out of the box exactly like the root query
     * already is. Pass `Infinity` explicitly to opt out and restore the old
     * unbounded-unless-you-ask behaviour.
     */
    maxRelationRows: number;
};

/** Everything threaded through the recursive build. */
interface BuildScope {
    security: NormalizedSecurity;
    jsonPathSyntax: JsonPathSyntax;
    /** Mask that applies at the current nesting level (`security.hidden`). */
    mask?: MaskNode;
}

/** Running total for {@link QueryBuilder.buildInclude}'s row-budget check. */
interface FanoutBudget {
    total: number;
}

/** Reserved keys inside an `include[relation]` object — everything else is a nested relation. */
const INCLUDE_CONTROL_KEYS = new Set(['where', 'orderBy', 'take', 'skip', 'select']);

/**
 * Turns a {@link RawSpec} (operator aliases, raw values) into a Prisma-ready
 * {@link QuerySpec}: validates every field/relation against the DMMF and the
 * security allow-list, maps operator aliases to Prisma operators, and coerces
 * values to their column type.
 *
 * This is the single place where filtering semantics live, shared by every input
 * adapter that speaks the operator vocabulary.
 */
export class QueryBuilder {
    static build(raw: RawSpec, model: ModelMeta, ctx: BuildContext): QuerySpec {
        const supplied = ctx.security ?? DEFAULT_SECURITY;
        // Callers (tests, advanced integrations) may build `ResolvedSecurity` by
        // hand without the newer budget fields — default them here rather than
        // requiring every call site to know about them. `maxRelationRows` in
        // particular defaults to the request's own page size, so a to-many
        // relation in `include` is bounded out of the box, the same as the root
        // query already is — pass `Infinity` explicitly to opt back out.
        const security: NormalizedSecurity = {
            ...supplied,
            maxInValues: supplied.maxInValues ?? DEFAULT_MAX_IN_VALUES,
            maxOrBranches: supplied.maxOrBranches ?? DEFAULT_MAX_OR_BRANCHES,
            maxFanout: supplied.maxFanout ?? DEFAULT_MAX_FANOUT,
            maxRelationRows: supplied.maxRelationRows ?? ctx.defaults.limit,
        };
        const scope: BuildScope = {
            security,
            jsonPathSyntax: ctx.jsonPathSyntax ?? 'array',
            mask: security.hidden,
        };
        const spec: QuerySpec = {};

        let where = raw.where ? QueryBuilder.buildWhere(raw.where, model, scope, 0) : undefined;

        // `search` convenience → OR (contains) across configured fields.
        // Hidden fields drop out: they must not be probed, not even indirectly.
        const searchable = FieldMask.visible(ctx.searchable, scope.mask);
        if (raw.search && searchable.length > 0) {
            const or = searchable.map(field => ({ [field]: { contains: raw.search } }));
            where = where ? { AND: [where, { OR: or }] } : { OR: or };
        }
        if (where) spec.where = where;

        // group-by has its own Prisma constraints, so the list defaults are skipped.
        const grouping = !!raw.by;

        if (raw.orderBy?.length) {
            spec.orderBy = QueryBuilder.buildOrderBy(raw.orderBy, model, scope);
        } else if (!grouping) {
            const sortField = model.field(ctx.defaults.sort)?.name;
            if (sortField) spec.orderBy = [{ [sortField]: ctx.defaults.order }];
        }

        // Computed early (rather than after include) so the root `take` seeds the
        // row-budget estimate below.
        QueryBuilder.applyPagination(raw, spec, ctx, grouping);

        // Prisma forbids `select` and `include` together → select wins.
        if (raw.select) {
            spec.select = QueryBuilder.buildSelect(raw.select, model, scope);
        } else if (raw.include) {
            const fanout: FanoutBudget = { total: 0 };
            const rootRows = Math.max(1, spec.take ?? 1);
            const include = QueryBuilder.buildInclude(raw.include, model, scope, 0, rootRows, fanout);
            // Everything asked for may have been a composite (always returned anyway).
            if (Object.keys(include).length > 0) {
                spec.include = include;
                spec.estimatedRows = rootRows + fanout.total;
            }
        }

        if (raw.distinct) spec.distinct = QueryBuilder.fieldList(raw.distinct, model, scope, 'distinct');
        if (raw.cursor !== undefined && raw.cursor !== '') {
            spec.cursor = QueryBuilder.buildCursor(raw.cursor, model, scope);
        }

        QueryBuilder.applyAggregations(raw, spec, model, scope);

        // `having` uses Prisma's aggregation shape (field → _sum/_avg… → op).
        if (raw.having && typeof raw.having === 'object') spec.having = raw.having;

        return spec;
    }

    // ── where ────────────────────────────────────────────────────────────────

    private static buildWhere(
        node: any,
        model: ModelMeta,
        scope: BuildScope,
        depth: number,
    ): Record<string, any> {
        if (depth > scope.security.maxDepth) throw new BadRequest({ msg: 'Filter nesting too deep' });
        if (node === null || typeof node !== 'object' || Array.isArray(node)) {
            throw new BadRequest({ msg: 'Filter must be an object' });
        }

        const out: Record<string, any> = {};

        for (const [key, value] of Object.entries(node)) {
            const logical = OperatorRegistry.logical(key);
            if (logical) {
                if (logical === 'NOT') {
                    out.NOT = QueryBuilder.buildWhere(value, model, scope, depth + 1);
                } else {
                    const branches = Array.isArray(value) ? value : Object.values(value as any);
                    if (branches.length > scope.security.maxOrBranches) {
                        throw new BadRequest({
                            msg: `Too many '${logical}' branches (${branches.length}); limit is ${scope.security.maxOrBranches} (security.maxOrBranches)`,
                        });
                    }
                    out[logical] = branches.map((sub: any) =>
                        QueryBuilder.buildWhere(sub, model, scope, depth + 1),
                    );
                }
                continue;
            }

            // A hidden name is treated as if it did not exist at all.
            if (FieldMask.hides(scope.mask, key)) throw QueryBuilder.unknown(key, model, scope);

            const relation = model.relation(key);
            if (relation) {
                QueryBuilder.assertRelationAllowed(relation, scope.security);
                out[relation.name] = QueryBuilder.buildRelation(value, relation, scope, depth + 1);
                continue;
            }

            const composite = model.composite(key);
            if (composite) {
                QueryBuilder.assertFieldAllowed(composite.name, scope.security);
                out[composite.name] = QueryBuilder.buildComposite(value, composite, scope, depth + 1);
                continue;
            }

            const field = QueryBuilder.resolveField(model, key, scope);
            out[field.name] = field.type === 'Json'
                ? QueryBuilder.buildJson(value, scope.jsonPathSyntax)
                : QueryBuilder.buildFieldCondition(value, field, scope);
        }

        return out;
    }

    private static buildRelation(
        value: any,
        relation: RelationMeta,
        scope: BuildScope,
        depth: number,
    ): Record<string, any> {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new BadRequest({ msg: `Relation '${relation.name}' expects a nested filter object` });
        }

        const related = DmmfRegistry.model(relation.target);
        const inner = QueryBuilder.descend(scope, relation.name);
        const keys = Object.keys(value);

        if (keys.some(key => OperatorRegistry.isRelation(key))) {
            const result: Record<string, any> = {};
            for (const [key, sub] of Object.entries(value)) {
                if (!OperatorRegistry.isRelation(key)) {
                    throw new BadRequest({ msg: `Invalid relation operator '${key}' on '${relation.name}'` });
                }
                result[key] = QueryBuilder.buildWhere(sub, related, inner, depth + 1);
            }
            return result;
        }

        // Bare nested filter: wrap to-many in `some`, keep to-one direct.
        const filter = QueryBuilder.buildWhere(value, related, inner, depth + 1);
        return relation.isList ? { some: filter } : filter;
    }

    /**
     * Build the filter for an embedded MongoDB composite type.
     *
     * Prisma does not accept a bare nested object here — that shape means *whole
     * document equality* — so a plain filter is wrapped in `is` (single document)
     * or `some` (list), which is what `?filter[program][shortname]=X` means.
     *
     * @example
     * // filter[program][shortname]=MAT → { program: { is: { shortname: 'MAT' } } }
     * // filter[program][subjects][type]=lab
     * //   → { program: { is: { subjects: { some: { type: 'lab' } } } } }
     */
    private static buildComposite(
        value: any,
        composite: CompositeMeta,
        scope: BuildScope,
        depth: number,
    ): Record<string, any> {
        if (depth > scope.security.maxDepth) throw new BadRequest({ msg: 'Filter nesting too deep' });

        // `program=null` on an optional embedded document.
        if (value === null) return { is: null };
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new BadRequest({
                msg: `Composite field '${composite.name}' expects a nested filter object`,
            });
        }

        const target = DmmfRegistry.composite(composite.target);
        const inner = QueryBuilder.descend(scope, composite.name);
        const keys = Object.keys(value);

        if (keys.some(key => OperatorRegistry.isComposite(key, composite.isList))) {
            const result: Record<string, any> = {};
            for (const [key, sub] of Object.entries(value)) {
                const op = OperatorRegistry.composite(key, composite.isList);
                if (!op) {
                    throw new BadRequest({
                        msg: `Invalid operator '${key}' on composite field '${composite.name}'. Available: ${OperatorRegistry.compositeNames(composite.isList).join(', ')}`,
                    });
                }
                if (OperatorRegistry.COMPOSITE_FLAG_OPS.has(op)) {
                    result[op] = sub === true || sub === 'true' || sub === 1 || sub === '1';
                } else if (op === 'equals') {
                    // Whole-document equality: Prisma matches the value verbatim.
                    result.equals = sub;
                } else if (sub === null) {
                    result[op] = null;
                } else {
                    result[op] = QueryBuilder.buildWhere(sub, target, inner, depth + 1);
                }
            }
            return result;
        }

        const filter = QueryBuilder.buildWhere(value, target, inner, depth + 1);
        return composite.isList ? { some: filter } : { is: filter };
    }

    /** Same scope, moved one level down the `hidden` mask tree. */
    private static descend(scope: BuildScope, name: string): BuildScope {
        const mask = FieldMask.child(scope.mask, name);
        return mask === scope.mask ? scope : { ...scope, mask };
    }

    private static buildFieldCondition(value: any, field: FieldMeta, scope: BuildScope): any {
        if (value === null) return null;
        if (Array.isArray(value)) {
            const list = ValueCoercer.fieldList(value, field);
            QueryBuilder.assertListSize(list, scope.security.maxInValues, field.name);
            return { in: list };
        }
        if (typeof value !== 'object') return ValueCoercer.field(value, field);

        const condition: Record<string, any> = {};
        for (const [key, operand] of Object.entries(value)) {
            const op = OperatorRegistry.field(key);
            if (!op) throw new BadRequest({ msg: `Unknown operator '${key}'` });

            if (op === 'isNull') {
                const truthy = operand === true || operand === 'true' || operand === 1 || operand === '1';
                if (truthy) condition.equals = null;
                else condition.not = null;
            } else if (OperatorRegistry.LIST_OPS.has(op)) {
                const list = ValueCoercer.fieldList(operand, field);
                QueryBuilder.assertListSize(list, scope.security.maxInValues, field.name);
                condition[op] = list;
            } else if (op === 'mode') {
                condition.mode = operand;
            } else if (OperatorRegistry.PARTIAL_OPS.has(op)) {
                // `contains`/`startsWith`/… carry fragments, so the native-type check
                // (a full ObjectId, say) must not apply to them.
                condition[op] = ValueCoercer.scalar(operand, field.type);
            } else if (op === 'not') {
                condition.not = operand !== null && typeof operand === 'object'
                    ? QueryBuilder.buildFieldCondition(operand, field, scope)
                    : ValueCoercer.field(operand, field);
            } else {
                condition[op] = ValueCoercer.field(operand, field);
            }
        }
        return condition;
    }

    /** Pass a JSON filter through, normalising `path` to the datasource syntax. */
    private static buildJson(value: any, syntax: JsonPathSyntax): any {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return { equals: ValueCoercer.jsonLeaf(value) };
        }
        const out: Record<string, any> = {};
        for (const [key, operand] of Object.entries(value)) {
            if (key === 'path') {
                out.path = QueryBuilder.normalizeJsonPath(operand, syntax);
            } else if (operand !== null && typeof operand === 'object' && !Array.isArray(operand)) {
                out[key] = QueryBuilder.buildJson(operand, syntax);
            } else {
                out[key] = typeof operand === 'string' ? ValueCoercer.jsonLeaf(operand) : operand;
            }
        }
        return out;
    }

    private static normalizeJsonPath(path: any, syntax: JsonPathSyntax): string[] | string {
        const segments = Array.isArray(path)
            ? path.map(String)
            : String(path).replace(/^\$\./, '').split('.');
        return syntax === 'string' ? `$.${segments.join('.')}` : segments;
    }

    // ── orderBy / select / include ─────────────────────────────────────────────

    private static buildOrderBy(
        orderBy: Array<Record<string, SortDir>>,
        model: ModelMeta,
        scope: BuildScope,
    ): Array<Record<string, SortDir>> {
        return orderBy.map(entry => {
            const [field, dir] = Object.entries(entry)[0];
            const resolved = QueryBuilder.resolveField(model, field, scope, 'sort by');
            return { [resolved.name]: dir === 'desc' ? 'desc' : 'asc' } as Record<string, SortDir>;
        });
    }

    private static buildSelect(
        fields: Record<string, any>,
        model: ModelMeta,
        scope: BuildScope,
    ): Record<string, any> {
        const out: Record<string, any> = {};
        for (const key of Object.keys(fields)) {
            // An embedded composite document can be projected as a whole.
            const composite = !FieldMask.hides(scope.mask, key) && model.composite(key);
            if (composite) {
                QueryBuilder.assertFieldAllowed(composite.name, scope.security, 'select');
                out[composite.name] = true;
                continue;
            }
            out[QueryBuilder.resolveField(model, key, scope, 'select').name] = true;
        }
        return out;
    }

    /**
     * Build a Prisma `include` tree, applying the row budget as it goes: every
     * to-many relation gets a `take` — the client's own (capped at
     * `security.maxRelationRows`), or that ceiling itself when the client left it
     * out — and the running estimate of materialised rows (`multiplier`, the
     * number of parent rows this branch hangs off) is checked against
     * `security.maxFanout` so a handful of nested collections cannot multiply into
     * hundreds of thousands of rows.
     *
     * `multiplier` only tracks branches whose row count is actually known — every
     * relation, by default — so only a relation explicitly opted out of the budget
     * (`security.maxRelationRows: Infinity`) is invisible to the estimate.
     */
    private static buildInclude(
        include: any,
        model: ModelMeta,
        scope: BuildScope,
        depth: number,
        multiplier: number,
        fanout: FanoutBudget,
    ): Record<string, any> {
        if (depth > scope.security.maxDepth) throw new BadRequest({ msg: 'Include nesting too deep' });
        const out: Record<string, any> = {};
        for (const [key, value] of Object.entries(include)) {
            if (FieldMask.hides(scope.mask, key)) {
                throw new BadRequest({ msg: `Cannot include unknown relation '${key}' on ${model.name}` });
            }

            // Embedded composite documents always come back with the row; Prisma
            // rejects them inside `include`, so asking for one is a no-op.
            if (model.composite(key)) continue;

            const relation = model.relation(key);
            if (!relation) {
                throw new BadRequest({ msg: `Cannot include unknown relation '${key}' on ${model.name}` });
            }
            QueryBuilder.assertRelationAllowed(relation, scope.security);
            out[relation.name] = QueryBuilder.buildIncludeNode(
                relation, value, model, scope, depth, multiplier, fanout,
            );
        }
        return out;
    }

    /** One relation's `include` entry: `true`/omitted, or a control object (`where`/`orderBy`/`take`/`skip`/`select`) plus further nested relations. */
    private static buildIncludeNode(
        relation: RelationMeta,
        value: any,
        model: ModelMeta,
        scope: BuildScope,
        depth: number,
        multiplier: number,
        fanout: FanoutBudget,
    ): any {
        const related = DmmfRegistry.model(relation.target);
        const inner = QueryBuilder.descend(scope, relation.name);

        if (value !== true && value != null && (typeof value !== 'object' || Array.isArray(value))) {
            throw new BadRequest({ msg: `Include for relation '${relation.name}' expects true or an object` });
        }
        const control: Record<string, any> = value && typeof value === 'object' ? value : {};

        if (!relation.isList && (control.take !== undefined || control.skip !== undefined || control.orderBy !== undefined)) {
            throw new BadRequest({ msg: `'take'/'skip'/'orderBy' are not valid on to-one relation '${relation.name}'` });
        }

        const node: Record<string, any> = {};
        if (control.where !== undefined) {
            node.where = QueryBuilder.buildWhere(control.where, related, inner, depth + 1);
        }
        if (control.orderBy !== undefined) {
            const list = Array.isArray(control.orderBy) ? control.orderBy : [control.orderBy];
            node.orderBy = QueryBuilder.buildOrderBy(list, related, inner);
        }

        let childMultiplier = multiplier;
        if (relation.isList) {
            const effectiveTake = QueryBuilder.relationTake(control.take, scope);
            // `Infinity` is the explicit "leave this relation unbounded" escape
            // hatch (`security.maxRelationRows: Infinity`) — never a valid Prisma
            // `take`, and not counted toward the fanout estimate either.
            const bounded = Number.isFinite(effectiveTake);
            if (bounded) node.take = effectiveTake;
            if (control.skip !== undefined) node.skip = QueryBuilder.toNonNegativeInt(control.skip, 'skip');

            if (bounded) {
                const rows = multiplier * effectiveTake;
                fanout.total += rows;
                if (fanout.total > scope.security.maxFanout) {
                    throw new BadRequest({
                        msg: `Include plan too expensive: estimated ${Math.round(fanout.total)} rows across nested relations exceeds the limit of ${scope.security.maxFanout} (security.maxFanout). Add a smaller 'take' to nested relations, or raise the limit.`,
                    });
                }
                childMultiplier = rows;
            }
        }

        const nestedKeys = Object.fromEntries(
            Object.entries(control).filter(([key]) => !INCLUDE_CONTROL_KEYS.has(key)),
        );
        if (control.select !== undefined) {
            node.select = QueryBuilder.buildSelect(control.select, related, inner);
        } else if (Object.keys(nestedKeys).length > 0) {
            const nested = QueryBuilder.buildInclude(nestedKeys, related, inner, depth + 1, childMultiplier, fanout);
            if (Object.keys(nested).length > 0) node.include = nested;
        }

        return Object.keys(node).length === 0 ? true : node;
    }

    /**
     * Resolve the effective `take` for a to-many relation: an explicit `take` is
     * capped at `security.maxRelationRows`, and an omitted one defaults to it —
     * which, unless the endpoint overrides it, is the request's own page size
     * (`ctx.defaults.limit`; see the normalisation in {@link QueryBuilder.build}).
     * Pass `security.maxRelationRows: Infinity` to restore a fully unbounded
     * relation; `relationTake` then returns `Infinity` and the caller treats that
     * as "no `take`, don't count it toward the fanout budget".
     */
    private static relationTake(requested: any, scope: BuildScope): number {
        if (requested !== undefined) {
            return Math.min(QueryBuilder.toNonNegativeInt(requested, 'take'), scope.security.maxRelationRows);
        }
        return scope.security.maxRelationRows;
    }

    private static toNonNegativeInt(value: any, label: string): number {
        const n = typeof value === 'number' ? value : parseInt(String(value), 10);
        if (!Number.isFinite(n) || n < 0) {
            throw new BadRequest({ msg: `Invalid '${label}' value '${value}': expected a non-negative integer` });
        }
        return n;
    }

    private static assertListSize(list: unknown[], max: number, field: string): void {
        if (list.length > max) {
            throw new BadRequest({
                msg: `Too many values for '${field}' (${list.length}); limit is ${max} (security.maxInValues)`,
            });
        }
    }

    // ── pagination / aggregations ──────────────────────────────────────────────

    private static applyPagination(
        raw: RawSpec,
        spec: QuerySpec,
        ctx: BuildContext,
        grouping: boolean,
    ): void {
        if (!grouping) {
            const take = Math.min(raw.limit ?? ctx.defaults.limit, ctx.defaults.maxLimit);
            spec.take = raw.take ?? take;
            if (raw.skip !== undefined) {
                spec.skip = raw.skip;
            } else if (raw.cursor !== undefined && raw.page === undefined) {
                // Cursor mode: leave skip undefined so the executor skips the cursor row.
            } else {
                spec.skip = (Math.max(1, raw.page ?? 1) - 1) * spec.take;
            }
            return;
        }

        if (raw.take !== undefined || raw.limit !== undefined) {
            spec.take = Math.min(raw.take ?? raw.limit!, ctx.defaults.maxLimit);
        }
        if (raw.skip !== undefined) spec.skip = raw.skip;
        else if (raw.page !== undefined && spec.take) spec.skip = (Math.max(1, raw.page) - 1) * spec.take;
    }

    private static applyAggregations(
        raw: RawSpec,
        spec: QuerySpec,
        model: ModelMeta,
        scope: BuildScope,
    ): void {
        if (raw.by) spec.by = QueryBuilder.fieldList(raw.by, model, scope, 'group by');
        if (raw.sum) spec._sum = QueryBuilder.fieldFlags(raw.sum, model, scope);
        if (raw.avg) spec._avg = QueryBuilder.fieldFlags(raw.avg, model, scope);
        if (raw.min) spec._min = QueryBuilder.fieldFlags(raw.min, model, scope);
        if (raw.max) spec._max = QueryBuilder.fieldFlags(raw.max, model, scope);

        if (raw.count === true || raw.count === 'true') {
            spec._count = true;
        } else if ((typeof raw.count === 'string' && raw.count !== 'false') || Array.isArray(raw.count)) {
            spec._count = QueryBuilder.fieldFlags(raw.count, model, scope);
        }
    }

    private static toList(value: string | string[]): string[] {
        return (Array.isArray(value) ? value : String(value).split(','))
            .map(item => (typeof item === 'string' ? item.trim() : item))
            .filter(Boolean) as string[];
    }

    private static fieldList(
        value: string | string[],
        model: ModelMeta,
        scope: BuildScope,
        verb: string,
    ): string[] {
        return QueryBuilder.toList(value).map(
            name => QueryBuilder.resolveField(model, name, scope, verb).name,
        );
    }

    private static fieldFlags(
        value: string | string[],
        model: ModelMeta,
        scope: BuildScope,
    ): Record<string, true> {
        const out: Record<string, true> = {};
        for (const name of QueryBuilder.toList(value)) {
            out[QueryBuilder.resolveField(model, name, scope, 'aggregate').name] = true;
        }
        return out;
    }

    /**
     * Build the `cursor` argument, coercing and validating it like any other value.
     *
     * Without this the cursor was the one input that reached Prisma unchecked, so
     * `?cursor=2` against a MongoDB `@db.ObjectId` id surfaced as a 500 from inside
     * the driver (`Malformed ObjectID`) instead of a 400.
     */
    private static buildCursor(value: any, model: ModelMeta, scope: BuildScope): Record<string, any> {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const out: Record<string, any> = {};
            for (const [key, operand] of Object.entries(value)) {
                const field = FieldMask.hides(scope.mask, key) ? undefined : model.field(key);
                // Unknown keys pass through: Prisma also accepts a compound unique
                // (`{ userId_campusId: { … } }`), which is no single field.
                out[key] = field ? QueryBuilder.cursorValue(operand, field) : operand;
            }
            return out;
        }

        const idField = model.field('id');
        if (!idField) {
            throw new BadRequest({
                msg: `Cursor pagination needs an 'id' field on ${model.name}; pass an explicit cursor object instead, e.g. cursor[uuid]=…`,
            });
        }
        return { [idField.name]: QueryBuilder.cursorValue(value, idField) };
    }

    /**
     * Coerce one cursor value, reporting failures in terms of the `cursor` parameter.
     *
     * A cursor is a *record identifier*, not a row number, and that is the single
     * most common misreading of it — so when the value does not fit the column, say
     * what a cursor is rather than complaining about a field the client never named.
     */
    private static cursorValue(value: any, field: FieldMeta): any {
        let coerced: any;
        try {
            coerced = ValueCoercer.field(value, field);
        } catch {
            throw QueryBuilder.badCursor(value, field);
        }

        // Coercion is best-effort: an unconvertible value comes back as the raw
        // string, which Prisma would then reject with a validation error of its own.
        const fits =
            field.type === 'Int' || field.type === 'Float' || field.type === 'Decimal'
                ? typeof coerced === 'number'
                : field.type === 'BigInt' ? typeof coerced === 'bigint'
                : field.type === 'DateTime' ? coerced instanceof Date
                : true;
        if (!fits) throw QueryBuilder.badCursor(value, field);

        return coerced;
    }

    private static badCursor(value: any, field: FieldMeta): BadRequest {
        const expected = field.nativeType === 'ObjectId'
            ? 'a 24-character hex ObjectId'
            : `a valid ${field.type}`;
        return new BadRequest({
            msg: `Invalid cursor '${value}': a cursor is the '${field.name}' of the last row you saw (see pagination.nextCursor), not a row number, and '${field.name}' expects ${expected}. For positional paging use page and limit instead.`,
        });
    }

    // ── access control ─────────────────────────────────────────────────────────

    private static resolveField(
        model: ModelMeta,
        name: string,
        scope: BuildScope,
        verb = 'filter by',
    ): FieldMeta {
        const field = FieldMask.hides(scope.mask, name) ? undefined : model.field(name);
        if (!field) throw QueryBuilder.unknown(name, model, scope);

        QueryBuilder.assertFieldAllowed(field.name, scope.security, verb);
        return field;
    }

    private static assertFieldAllowed(
        name: string,
        security: ResolvedSecurity,
        verb = 'filter by',
    ): void {
        if (security.fields !== '*' && !security.fields.has(name.toLowerCase())) {
            throw new BadRequest({ msg: `Cannot ${verb} field '${name}' (not allowed)` });
        }
    }

    private static assertRelationAllowed(relation: RelationMeta, security: ResolvedSecurity): void {
        if (security.relations !== '*' && !security.relations.has(relation.name.toLowerCase())) {
            throw new BadRequest({ msg: `Cannot traverse relation '${relation.name}' (not allowed)` });
        }
    }

    /**
     * The 400 raised for a name the client may not use. Hidden names are reported
     * exactly like names that do not exist, and never appear in the hint, so the
     * response cannot be used to probe for their existence.
     */
    private static unknown(name: string, model: ModelMeta, scope: BuildScope): BadRequest {
        const fields = FieldMask.visible(
            [...model.fieldNames(), ...model.compositeNames()],
            scope.mask,
        );
        const relations = FieldMask.visible(model.relationNames(), scope.mask);
        return new BadRequest({
            msg: `Unknown field '${name}' on ${model.name}. Available fields: ${fields.join(', ')}. Relations: ${relations.join(', ')}`,
        });
    }
}
