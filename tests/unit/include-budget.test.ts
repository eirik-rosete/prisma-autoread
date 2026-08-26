import { setupPrismaMock } from '../helpers/mock-dmmf';

jest.mock('@prisma/client', () => setupPrismaMock());

import { QueryBuilder } from '../../src/core/query-builder';
import { DmmfRegistry, ModelMeta } from '../../src/core/dmmf/registry';
import type { BuildContext, ResolvedSecurity } from '../../src/types/query';

const defaults = { limit: 10, maxLimit: 100, sort: 'id', order: 'asc' as const };
const ctx: BuildContext = { defaults, searchable: [] };

const security = (overrides: Partial<ResolvedSecurity>): BuildContext => ({
    defaults,
    searchable: [],
    security: { fields: '*', relations: '*', maxDepth: 12, ...overrides },
});

let user: ModelMeta;

beforeAll(() => {
    DmmfRegistry.clear();
    user = DmmfRegistry.model('user');
});

describe('QueryBuilder – include, default row budget (no config needed)', () => {
    it('bounds a to-many relation at defaults.limit when maxRelationRows is not configured', () => {
        const spec = QueryBuilder.build({ include: { enrolments: true } }, user, ctx);
        expect(spec.include).toEqual({ enrolments: { take: defaults.limit } });
        // root rows + (root rows * relation take)
        expect(spec.estimatedRows).toBe(defaults.limit + defaults.limit * defaults.limit);
    });

    it('still supports the flat nested-relation shape, now with the default take attached', () => {
        const spec = QueryBuilder.build({ include: { enrolments: { campus: true } } }, user, ctx);
        expect(spec.include).toEqual({ enrolments: { take: defaults.limit, include: { campus: true } } });
    });

    it('caps an explicit nested take at defaults.limit when maxRelationRows is not configured', () => {
        const spec = QueryBuilder.build(
            { include: { enrolments: { take: 999 } } },
            user,
            ctx,
        );
        expect((spec.include as any).enrolments.take).toBe(defaults.limit);
    });

    it('opts a relation back out of the budget with security.maxRelationRows: Infinity', () => {
        const spec = QueryBuilder.build(
            { include: { enrolments: true } },
            user,
            security({ maxRelationRows: Infinity }),
        );
        expect(spec.include).toEqual({ enrolments: true });
    });
});

describe('QueryBuilder – include, per-relation where/orderBy/take/skip/select', () => {
    it('accepts where/orderBy/take/skip alongside further nested relations', () => {
        const spec = QueryBuilder.build({
            include: {
                enrolments: {
                    where: { campusId: '2' },
                    orderBy: { id: 'desc' },
                    take: 5,
                    skip: 1,
                    campus: true,
                },
            },
        }, user, ctx);

        expect(spec.include).toEqual({
            enrolments: {
                where: { campusId: 2 },
                orderBy: [{ id: 'desc' }],
                take: 5,
                skip: 1,
                include: { campus: true },
            },
        });
    });

    it('projects a nested select, mutually exclusive with nested include (still bounded)', () => {
        const spec = QueryBuilder.build({
            include: { enrolments: { select: { id: true }, campus: true } },
        }, user, ctx);
        expect(spec.include).toEqual({ enrolments: { select: { id: true }, take: defaults.limit } });
    });

    it('rejects take/skip/orderBy on a to-one relation', () => {
        expect(() => QueryBuilder.build(
            { include: { enrolments: { campus: { take: 1 } } } },
            user,
            ctx,
        )).toThrow(/to-one relation/);
    });
});

describe('QueryBuilder – security.maxRelationRows', () => {
    it('auto-injects the configured default take on a to-many relation that omits it', () => {
        const spec = QueryBuilder.build(
            { include: { enrolments: true } },
            user,
            security({ maxRelationRows: 25 }),
        );
        expect(spec.include).toEqual({ enrolments: { take: 25 } });
    });

    it('caps an explicit take below the configured ceiling', () => {
        const spec = QueryBuilder.build(
            { include: { enrolments: { take: 999 } } },
            user,
            security({ maxRelationRows: 25 }),
        );
        expect((spec.include as any).enrolments.take).toBe(25);
    });

    it('leaves a smaller explicit take untouched', () => {
        const spec = QueryBuilder.build(
            { include: { enrolments: { take: 5 } } },
            user,
            security({ maxRelationRows: 25 }),
        );
        expect((spec.include as any).enrolments.take).toBe(5);
    });
});

describe('QueryBuilder – security.maxFanout', () => {
    it('rejects an include tree whose estimated rows exceed the budget', () => {
        expect(() => QueryBuilder.build(
            { take: 100, include: { enrolments: { take: 100, campus: { enrolments: { take: 100 } } } } },
            user,
            security({ maxFanout: 5000, maxRelationRows: 1000 }),
        )).toThrow(/Include plan too expensive/);
    });

    it('allows the same shape under a wider budget', () => {
        const spec = QueryBuilder.build(
            { take: 100, include: { enrolments: { take: 100, campus: { enrolments: { take: 100 } } } } },
            user,
            security({ maxFanout: 2_000_000, maxRelationRows: 1000 }),
        );
        expect(spec.estimatedRows).toBe(100 + 100 * 100 + 100 * 100 * 100);
    });

    it('does not count a relation explicitly opted out of the budget (maxRelationRows: Infinity)', () => {
        const spec = QueryBuilder.build(
            { take: 10, include: { enrolments: true } },
            user,
            security({ maxFanout: 1, maxRelationRows: Infinity }),
        );
        expect(spec.include).toEqual({ enrolments: true });
    });
});

describe('QueryBuilder – security.maxInValues / maxOrBranches', () => {
    it('rejects an in-list past the configured size', () => {
        expect(() => QueryBuilder.build(
            { where: { id: { in: [1, 2, 3] } } },
            user,
            security({ maxInValues: 2 }),
        )).toThrow(/Too many values/);
    });

    it('rejects a bare array filter past the configured size', () => {
        expect(() => QueryBuilder.build(
            { where: { id: [1, 2, 3] } },
            user,
            security({ maxInValues: 2 }),
        )).toThrow(/Too many values/);
    });

    it('rejects an OR with too many branches', () => {
        expect(() => QueryBuilder.build(
            { where: { or: [{ id: '1' }, { id: '2' }, { id: '3' }] } },
            user,
            security({ maxOrBranches: 2 }),
        )).toThrow(/Too many 'OR' branches/);
    });

    it('applies the default limits (1000 / 50) when unconfigured', () => {
        const spec = QueryBuilder.build({ where: { id: { in: [1, 2, 3] } } }, user, ctx);
        expect(spec.where).toEqual({ id: { in: [1, 2, 3] } });
    });
});
