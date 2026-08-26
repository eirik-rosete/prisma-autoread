import { setupPrismaMock } from '../helpers/mock-dmmf';

jest.mock('@prisma/client', () => setupPrismaMock());

import { QueryBracketsAdapter } from '../../src/input/query-brackets.adapter';
import { JsonBodyAdapter } from '../../src/input/json-body.adapter';
import { LegacyAdapter } from '../../src/input/legacy.adapter';
import { RsqlAdapter } from '../../src/input/rsql.adapter';
import { ODataAdapter } from '../../src/input/odata.adapter';
import { DmmfRegistry } from '../../src/core/dmmf/registry';
import { Keywords } from '../../src/config/keywords';
import type { AdapterContext } from '../../src/types/adapters';

const KEYWORDS = Keywords.current();

const build = (searchable: string[] = []) => ({
    defaults: { limit: 10, maxLimit: 100, sort: 'id', order: 'asc' as const },
    searchable,
});

let userCtx: AdapterContext;
let enrolmentCtx: AdapterContext;

beforeAll(() => {
    DmmfRegistry.clear();
    userCtx = { model: DmmfRegistry.model('user'), build: build(), keywords: KEYWORDS };
    enrolmentCtx = { model: DmmfRegistry.model('userEnrolment'), build: build(), keywords: KEYWORDS };
});

describe('QueryBracketsAdapter (GET)', () => {
    const adapter = new QueryBracketsAdapter();

    it('supports GET unless the filter is a string', () => {
        expect(adapter.supports({ method: 'GET', query: {} }, KEYWORDS)).toBe(true);
        expect(adapter.supports({ method: 'QUERY', query: {} }, KEYWORDS)).toBe(false);
        expect(adapter.supports({ method: 'GET', query: { filter: 'a==1' } }, KEYWORDS)).toBe(false);
    });

    it('parses filter + operators', async () => {
        const spec = await adapter.parse(
            { method: 'GET', query: { filter: { age: { gte: '30' } } } },
            userCtx,
        );
        expect(spec.where).toEqual({ age: { gte: 30 } });
    });

    it('parses sort, fields, include', async () => {
        expect((await adapter.parse({ method: 'GET', query: { sort: '-age,firstName' } }, userCtx)).orderBy)
            .toEqual([{ age: 'desc' }, { firstName: 'asc' }]);
        expect((await adapter.parse({ method: 'GET', query: { fields: 'id,firstName' } }, userCtx)).select)
            .toEqual({ id: true, firstName: true });
        // `enrolments` is to-many, so it gets the default row budget (defaults.limit) unless configured.
        expect((await adapter.parse({ method: 'GET', query: { include: 'enrolments' } }, userCtx)).include)
            .toEqual({ enrolments: { take: 10 } });
    });

    it('parses pagination + search', async () => {
        const spec = await adapter.parse(
            { method: 'GET', query: { page: '2', limit: '5', search: 'al' } },
            { ...userCtx, build: build(['firstName', 'email']) },
        );
        expect(spec.take).toBe(5);
        expect(spec.skip).toBe(5);
        expect(spec.where).toEqual({
            OR: [{ firstName: { contains: 'al' } }, { email: { contains: 'al' } }],
        });
    });

    it('honours renamed keywords', async () => {
        const keywords = { ...KEYWORDS, fields: 'select', filter: 'q' };
        const spec = await adapter.parse(
            { method: 'GET', query: { select: 'id,firstName', q: { age: { gte: '30' } } } },
            { ...userCtx, keywords },
        );
        expect(spec.select).toEqual({ id: true, firstName: true });
        expect(spec.where).toEqual({ age: { gte: 30 } });
    });
});

describe('RsqlAdapter / ODataAdapter (GET)', () => {
    it('RSQL takes over when the filter is a string', async () => {
        const adapter = new RsqlAdapter();
        expect(adapter.supports({ method: 'GET', query: { filter: 'age=ge=30' } }, KEYWORDS)).toBe(true);
        expect(adapter.supports({ method: 'GET', query: { filter: {} } }, KEYWORDS)).toBe(false);

        const spec = await adapter.parse({ method: 'GET', query: { filter: 'age=ge=30' } }, userCtx);
        expect(spec.where).toEqual({ age: { gte: 30 } });
    });

    it('OData takes over on $filter', async () => {
        const adapter = new ODataAdapter();
        expect(adapter.supports({ method: 'GET', query: { $filter: 'age gt 30' } })).toBe(true);
        expect(adapter.supports({ method: 'GET', query: {} })).toBe(false);

        const spec = await adapter.parse({ method: 'GET', query: { $filter: 'age gt 30' } }, userCtx);
        expect(spec.where).toEqual({ age: { gt: 30 } });
    });
});

describe('JsonBodyAdapter (QUERY / POST)', () => {
    const adapter = new JsonBodyAdapter();

    it('supports QUERY/POST with an object body', () => {
        expect(adapter.supports({ method: 'QUERY', query: {}, body: {} })).toBe(true);
        expect(adapter.supports({ method: 'POST', query: {}, body: {} })).toBe(true);
        expect(adapter.supports({ method: 'GET', query: {}, body: {} })).toBe(false);
        expect(adapter.supports({ method: 'QUERY', query: {} })).toBe(false);
    });

    it('parses a Prisma-native body', async () => {
        const spec = await adapter.parse(
            {
                method: 'QUERY',
                query: {},
                body: {
                    where: { age: { gte: 30 }, OR: [{ active: true }] },
                    orderBy: [{ lastName: 'desc' }],
                    select: { id: true },
                    limit: 5,
                    page: 2,
                },
            },
            userCtx,
        );
        expect(spec.where).toEqual({ age: { gte: 30 }, OR: [{ active: true }] });
        expect(spec.orderBy).toEqual([{ lastName: 'desc' }]);
        expect(spec.select).toEqual({ id: true });
        expect(spec.take).toBe(5);
        expect(spec.skip).toBe(5);
    });
});

describe('LegacyAdapter (GET back-compat)', () => {
    const userAdapter = new LegacyAdapter({ modelName: 'User', searchableFields: ['firstName', 'email'] });
    const enrolmentAdapter = new LegacyAdapter({ modelName: 'UserEnrolment' });

    it('parses a scalar filter (old syntax)', async () => {
        const spec = await userAdapter.parse({ method: 'GET', query: { age: '30' } }, userCtx);
        expect(spec.where).toEqual({ age: 30 });
    });

    it('parses the old LIKE operator', async () => {
        const spec = await userAdapter.parse(
            { method: 'GET', query: { firstName: { LIKE: 'al' } } },
            userCtx,
        );
        expect(spec.where).toEqual({ firstName: { contains: 'al' } });
    });

    it('parses an old relation filter', async () => {
        const spec = await enrolmentAdapter.parse(
            { method: 'GET', query: { campus: { uuid: 'A' } } },
            enrolmentCtx,
        );
        expect(spec.where).toEqual({ campus: { uuid: 'A' } });
    });

    it('parses an old OR group', async () => {
        const spec = await userAdapter.parse(
            { method: 'GET', query: { or: { g1: { firstName: 'Alice', lastName: 'Jones' } } } },
            userCtx,
        );
        expect(spec.where).toEqual({
            AND: [{ OR: [{ firstName: 'Alice' }, { lastName: 'Jones' }] }],
        });
    });
});
