import { setupPrismaMock } from '../helpers/mock-dmmf';

jest.mock('@prisma/client', () => setupPrismaMock());

import http from 'http';
import express, { Router } from 'express';
import request from 'supertest';
import { createAutoRead } from '../../src/auto-read';
import { AutoReadOptions } from '../../src/types/options';

const rows = [
    { id: 1, firstName: 'Alice', age: 30 },
    { id: 2, firstName: 'Bob', age: 25 },
];

function buildApp(config: Partial<AutoReadOptions> = {}) {
    const captured: { args?: any; countArgs?: any } = {};
    const delegate = {
        findMany: async (args: any) => { captured.args = args; return rows; },
        count: async (args: any) => { captured.countArgs = args; return rows.length; },
    };

    const app = express();
    const router = Router();
    createAutoRead({
        model: 'User',
        delegate,
        methods: ['GET', 'QUERY', 'POST'],
        routes: ['list', 'count'],
        legacy: false,
        searchable: ['firstName', 'email'],
        ...config,
    }).applyTo(router);
    app.use('/users', router);
    app.use((err: any, _req: any, res: any, _next: any) =>
        res.status(err.status ?? 500).json({ error: err.message }),
    );

    return { app, captured };
}

describe('[Integration] createAutoRead – GET (modern brackets)', () => {
    it('builds a Prisma where from filter brackets', async () => {
        const { app, captured } = buildApp();
        const res = await request(app).get('/users?filter%5Bage%5D%5Bgte%5D=30');
        expect(res.status).toBe(200);
        expect(captured.args.where).toEqual({ age: { gte: 30 } });
        expect(res.body.data).toHaveLength(2);
        expect(res.body._links.self).toBeDefined();
    });

    it('maps fields to select', async () => {
        const { app, captured } = buildApp();
        await request(app).get('/users?fields=id,firstName');
        expect(captured.args.select).toEqual({ id: true, firstName: true });
    });

    it('expands search over searchable fields', async () => {
        const { app, captured } = buildApp();
        await request(app).get('/users?search=al');
        expect(captured.args.where).toEqual({
            OR: [{ firstName: { contains: 'al' } }, { email: { contains: 'al' } }],
        });
    });

    it('paginates (page/limit → skip/take)', async () => {
        const { app, captured } = buildApp();
        const res = await request(app).get('/users?page=2&limit=1');
        expect(captured.args.take).toBe(1);
        expect(captured.args.skip).toBe(1);
        expect(res.body.pagination.page).toBe(2);
    });

    it('returns 400 for an unknown field', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/users?filter%5Bnope%5D=1');
        expect(res.status).toBe(400);
    });

    it('renders the plain output format', async () => {
        const { app } = buildApp({ output: 'plain' });
        const res = await request(app).get('/users');
        expect(res.body.meta).toBeDefined();
        expect(res.body._links).toBeUndefined();
    });
});

describe('[Integration] createAutoRead – count route', () => {
    it('serves a count at the default /count path, reusing the filter', async () => {
        const { app, captured } = buildApp();
        const res = await request(app).get('/users/count?filter%5Bage%5D%5Bgte%5D=30');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ count: 2 });
        expect(captured.countArgs.where).toEqual({ age: { gte: 30 } });
    });

    it('honours a custom route path', async () => {
        const { app } = buildApp({ routes: { list: true, count: { path: '/total' } } });
        const res = await request(app).get('/users/total');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ count: 2 });
    });
});

describe('[Integration] createAutoRead – security allow-list', () => {
    it('rejects a field outside the allow-list', async () => {
        const { app } = buildApp({ security: { fields: ['firstName'] } });
        const res = await request(app).get('/users?filter%5Bage%5D%5Bgte%5D=30');
        expect(res.status).toBe(400);
    });

    it('allows a whitelisted field', async () => {
        const { app, captured } = buildApp({ security: { fields: ['firstName'] } });
        const res = await request(app).get('/users?filter%5BfirstName%5D%5Bcontains%5D=Al');
        expect(res.status).toBe(200);
        expect(captured.args.where).toEqual({ firstName: { contains: 'Al' } });
    });
});

describe('[Integration] createAutoRead – body (POST / QUERY)', () => {
    it('builds a where from a JSON body (POST)', async () => {
        const { app, captured } = buildApp();
        const res = await request(app)
            .post('/users')
            .send({ where: { age: { gte: 30 } }, orderBy: [{ firstName: 'desc' }], limit: 5 });
        expect(res.status).toBe(200);
        expect(captured.args.where).toEqual({ age: { gte: 30 } });
        expect(captured.args.orderBy).toEqual([{ firstName: 'desc' }]);
        expect(captured.args.take).toBe(5);
    });

    it('routes the real QUERY HTTP method to the body adapter', async () => {
        const { app, captured } = buildApp();
        const server = app.listen(0);
        const port = (server.address() as any).port;
        const payload = JSON.stringify({ where: { age: { gte: 30 } }, limit: 5 });

        const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/users',
                    method: 'QUERY',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(payload),
                    },
                },
                res => {
                    let data = '';
                    res.on('data', c => (data += c));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
                },
            );
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        server.close();
        expect(result.status).toBe(200);
        expect(captured.args.where).toEqual({ age: { gte: 30 } });
        expect(captured.args.take).toBe(5);
    });
});

describe('[Integration] createAutoRead – legacy dialect on GET', () => {
    it('understands the old query syntax when legacy: true', async () => {
        const { app, captured } = buildApp({ legacy: true });
        const res = await request(app).get('/users?age=30');
        expect(res.status).toBe(200);
        expect(captured.args.where).toEqual({ age: 30 });
    });
});

describe('[Integration] createAutoRead – relationLoadStrategy', () => {
    it('is not sent to Prisma unless configured', async () => {
        const { app, captured } = buildApp();
        await request(app).get('/users?include=enrolments');
        expect(captured.args.relationLoadStrategy).toBeUndefined();
    });

    it('is forwarded only when include is present', async () => {
        const { app, captured } = buildApp({ relationLoadStrategy: 'query' });
        await request(app).get('/users?limit=5');
        expect(captured.args.relationLoadStrategy).toBeUndefined();

        await request(app).get('/users?include=enrolments');
        expect(captured.args.relationLoadStrategy).toBe('query');
    });
});

describe('[Integration] createAutoRead – onRecommendation', () => {
    it('is never invoked unless configured', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/users?filter%5Bfirstname%5D%5Bcontains%5D=al');
        expect(res.status).toBe(200);
        // No assertion possible on absence of calls without the hook — the point is
        // this request must not throw or behave differently when it is unset.
    });

    it('fires for a request whose shape warrants a finding', async () => {
        const found: any[] = [];
        const { app } = buildApp({ onRecommendation: r => found.push(r) });
        const res = await request(app).get('/users?filter%5Bfirstname%5D%5Bcontains%5D=al');
        expect(res.status).toBe(200);
        expect(found.some(r => r.code === 'unindexed-contains')).toBe(true);
    });

    it('reports estimatedRows via onQuery once include is present', async () => {
        const telemetry: any[] = [];
        const { app } = buildApp({ onQuery: t => telemetry.push(t) });
        const res = await request(app).get('/users?include=enrolments&limit=5');
        expect(res.status).toBe(200);
        // root rows (5) + root rows * the relation's default take (defaults.limit = 10)
        expect(telemetry[0].estimatedRows).toBe(5 + 5 * 10);
    });
});
