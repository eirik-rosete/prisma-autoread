import type { QuerySpec, QueryResult } from '../types/query';
import type { PrismaDelegate, ExecutorSource } from '../types/prisma';

/**
 * Runs a {@link QuerySpec} against Prisma, choosing the optimal function per route
 * and reusing the same `where` for data and count. Accepts either a Prisma delegate
 * (`prisma.user`) — which unlocks count/aggregate/groupBy — or a legacy `findByFilter`.
 */
export class Executor {
    constructor(private readonly source: ExecutorSource) {}

    /** List + total. Uses `findMany` + `count` in parallel, or the finder once. */
    async list(spec: QuerySpec): Promise<QueryResult> {
        if (this.source.finder) {
            const result = await this.source.finder(this.toArgs(spec));
            if (Array.isArray(result)) return { data: result, total: result.length };
            return { data: result.data, total: result.total ?? result.data.length };
        }

        const delegate = this.requireDelegate();
        const [data, total] = await Promise.all([
            delegate.findMany(this.toArgs(spec)),
            delegate.count(spec.where ? { where: spec.where } : {}),
        ]);
        return { data, total };
    }

    /** Count alone, reusing the filter without fetching rows. */
    async count(spec: QuerySpec): Promise<number> {
        if (this.source.finder) {
            const result = await this.source.finder({ where: spec.where, take: 0, skip: 0 });
            return Array.isArray(result) ? result.length : (result.total ?? result.data.length);
        }
        return this.requireDelegate().count(spec.where ? { where: spec.where } : {});
    }

    /** Aggregate (`_count`/`_sum`/`_avg`/`_min`/`_max`) over the filtered set. */
    async aggregate(spec: QuerySpec): Promise<any> {
        const delegate = this.requireDelegate();
        if (typeof delegate.aggregate !== 'function') {
            throw new Error('Executor: the delegate does not support aggregate()');
        }
        const args: Record<string, any> = {};
        if (spec.where) args.where = spec.where;
        this.applyAggregations(spec, args);
        if (args._count === undefined && !args._sum && !args._avg && !args._min && !args._max) {
            args._count = true;
        }
        return delegate.aggregate(args);
    }

    /** Group rows by one or more fields with aggregations. */
    async groupBy(spec: QuerySpec): Promise<any[]> {
        const delegate = this.requireDelegate();
        if (typeof delegate.groupBy !== 'function') {
            throw new Error('Executor: the delegate does not support groupBy()');
        }
        const args: Record<string, any> = { by: spec.by ?? [] };
        if (spec.where) args.where = spec.where;
        if (spec.having) args.having = spec.having;
        if (spec.orderBy) args.orderBy = spec.orderBy;
        if (spec.take !== undefined) args.take = spec.take;
        if (spec.skip !== undefined) args.skip = spec.skip;
        this.applyAggregations(spec, args);
        if (args._count === undefined) args._count = true;
        return delegate.groupBy(args);
    }

    private applyAggregations(spec: QuerySpec, args: Record<string, any>): void {
        if (spec._count !== undefined) args._count = spec._count;
        if (spec._sum) args._sum = spec._sum;
        if (spec._avg) args._avg = spec._avg;
        if (spec._min) args._min = spec._min;
        if (spec._max) args._max = spec._max;
    }

    private toArgs(spec: QuerySpec): Record<string, any> {
        const args: Record<string, any> = {};
        if (spec.where) args.where = spec.where;
        if (spec.orderBy) args.orderBy = spec.orderBy;
        if (spec.select) args.select = spec.select;
        else if (spec.include) args.include = spec.include;
        if (spec.take !== undefined) args.take = spec.take;
        if (spec.skip !== undefined) args.skip = spec.skip;
        if (spec.distinct) args.distinct = spec.distinct;
        if (spec.cursor) {
            args.cursor = spec.cursor;
            // With a cursor, skip the cursor row itself unless an explicit skip was set.
            if (spec.skip === undefined) args.skip = 1;
        }
        // Opt-in only (requires Prisma's `relationJoins` preview feature); never
        // set otherwise, and meaningless without a relation actually being loaded.
        if (this.source.relationLoadStrategy && args.include) {
            args.relationLoadStrategy = this.source.relationLoadStrategy;
        }
        return args;
    }

    private requireDelegate(): PrismaDelegate {
        if (!this.source.delegate) {
            throw new Error('Executor: a Prisma delegate is required for this operation');
        }
        return this.source.delegate;
    }
}
