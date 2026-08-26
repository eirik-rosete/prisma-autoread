import { setupPrismaMock } from '../helpers/mock-dmmf';

jest.mock('@prisma/client', () => setupPrismaMock());

import { QueryBuilder } from '../../src/core/query-builder';
import { RecommendationEngine } from '../../src/core/recommendations';
import { DmmfRegistry, ModelMeta } from '../../src/core/dmmf/registry';
import type { BuildContext, ResolvedSecurity } from '../../src/types/query';

const defaults = { limit: 10, maxLimit: 100, sort: 'id', order: 'asc' as const };
const ctx: BuildContext = { defaults, searchable: [] };
const baseSecurity: ResolvedSecurity = { fields: '*', relations: '*', maxDepth: 12 };

let user: ModelMeta;

beforeAll(() => {
    DmmfRegistry.clear();
    user = DmmfRegistry.model('user');
});

function codes(spec: ReturnType<typeof QueryBuilder.build>, security: ResolvedSecurity, provider?: string) {
    return RecommendationEngine.analyze(spec, 'User', security, provider).map(r => r.code);
}

describe('RecommendationEngine – include', () => {
    it('flags a relation explicitly opted out of the default row budget', () => {
        const security = { ...baseSecurity, maxRelationRows: Infinity };
        const spec = QueryBuilder.build({ include: { enrolments: true } }, user, { ...ctx, security });
        expect(codes(spec, security)).toContain('unbounded-relation');
    });

    it('does not flag it under the default budget (take is auto-injected)', () => {
        const spec = QueryBuilder.build({ include: { enrolments: true } }, user, ctx);
        expect(codes(spec, baseSecurity)).not.toContain('unbounded-relation');
    });

    it('does not flag a relation that already has an explicit take', () => {
        const spec = QueryBuilder.build({ include: { enrolments: { take: 5 } } }, user, ctx);
        expect(codes(spec, baseSecurity)).not.toContain('unbounded-relation');
    });
});

describe('RecommendationEngine – fanout', () => {
    it('warns when the estimate is close to the configured budget', () => {
        const security = { ...baseSecurity, maxFanout: 1000, maxRelationRows: 100 };
        const spec = QueryBuilder.build(
            { take: 10, include: { enrolments: { take: 90 } } },
            user,
            { ...ctx, security },
        );
        expect(codes(spec, security)).toContain('fanout-near-budget');
    });
});

describe('RecommendationEngine – where', () => {
    it('flags a large in-list relative to maxInValues', () => {
        const security = { ...baseSecurity, maxInValues: 20 };
        const spec = QueryBuilder.build(
            { where: { id: { in: Array.from({ length: 15 }, (_, i) => i) } } },
            user,
            { ...ctx, security },
        );
        expect(codes(spec, security)).toContain('large-in-list');
    });

    it('flags a contains filter once per field', () => {
        const spec = QueryBuilder.build({ where: { firstName: { contains: 'ali' } } }, user, ctx);
        const found = RecommendationEngine.analyze(spec, 'User', baseSecurity, 'postgresql');
        expect(found.filter(r => r.code === 'unindexed-contains')).toHaveLength(1);
    });

    it('flags many OR branches relative to maxOrBranches', () => {
        const security = { ...baseSecurity, maxOrBranches: 4 };
        const spec = QueryBuilder.build(
            { where: { or: [{ id: '1' }, { id: '2' }, { id: '3' }] } },
            user,
            { ...ctx, security },
        );
        expect(codes(spec, security)).toContain('many-logical-branches');
    });
});

describe('RecommendationEngine – pagination', () => {
    it('flags a deep offset', () => {
        const spec = QueryBuilder.build({ page: 200, limit: 10 }, user, ctx);
        expect(codes(spec, baseSecurity)).toContain('deep-offset-pagination');
    });

    it('does not flag cursor pagination regardless of skip', () => {
        const spec = QueryBuilder.build({ cursor: '5', limit: 10 }, user, ctx);
        expect(codes(spec, baseSecurity)).not.toContain('deep-offset-pagination');
    });
});

describe('RecommendationEngine – index hint', () => {
    it('suggests a composite index for filter + sort combos on SQL providers', () => {
        const spec = QueryBuilder.build(
            { where: { active: 'true' }, orderBy: [{ age: 'desc' }] },
            user,
            ctx,
        );
        const found = RecommendationEngine.analyze(spec, 'User', baseSecurity, 'postgresql');
        const hint = found.find(r => r.code === 'index-hint');
        expect(hint?.hint).toContain('CREATE INDEX');
        expect(hint?.hint).toContain('active, age');
    });

    it('skips the index hint on MongoDB', () => {
        const spec = QueryBuilder.build(
            { where: { active: 'true' }, orderBy: [{ age: 'desc' }] },
            user,
            ctx,
        );
        expect(codes(spec, baseSecurity, 'mongodb')).not.toContain('index-hint');
    });

    it('skips the hint for a single field (not worth suggesting)', () => {
        // orderBy repeats the filtered field, so after dedup there is only one column.
        const spec = QueryBuilder.build(
            { where: { active: 'true' }, orderBy: [{ active: 'asc' }] },
            user,
            ctx,
        );
        expect(codes(spec, baseSecurity, 'postgresql')).not.toContain('index-hint');
    });
});
