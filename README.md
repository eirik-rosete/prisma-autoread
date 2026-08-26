# prisma-autoread

<!-- Package -->
[![npm version](https://img.shields.io/npm/v/@didactika/prisma-autoread.svg?logo=npm)](https://www.npmjs.com/package/@didactika/prisma-autoread)
[![CI](https://img.shields.io/github/actions/workflow/status/didactika/prisma-autoread/ci.yml?branch=main&logo=github&label=CI)](https://github.com/didactika/prisma-autoread/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<!-- Runtime -->
[![Node](https://img.shields.io/badge/Node-20%20%7C%2022%20%7C%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/about/previous-releases)
[![Prisma](https://img.shields.io/badge/Prisma-5%20%7C%206%20%7C%207-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)

<!-- Frameworks -->
[![Express](https://img.shields.io/badge/Express-4%20%7C%205-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-4%20%7C%205-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono&logoColor=white)](https://hono.dev/)

<!-- Protocols -->
[![HTTP](https://img.shields.io/badge/HTTP-GET%20%C2%B7%20QUERY%20%C2%B7%20POST-005571)](#http-methods)
[![Formats](https://img.shields.io/badge/out-HAL%20%C2%B7%20JSON%3AAPI%20%C2%B7%20CSV-6f42c1)](#output-formats)

> Drop-in **search endpoints** for **Express + Prisma**. One declaration gives you
> filtering, sorting, field selection, relation includes, aggregations, pagination
> (offset **and** cursor) and multiple response formats — over `GET`, the new
> `QUERY` method, or `POST`. Query it *as if you were writing Prisma*.

```ts
createAutoRead({ model: 'User', delegate: prisma.user }).applyTo(router);
```
```
GET   /users?filter[age][gte]=30&sort=-createdAt&fields=id,firstName&page=2
QUERY /users     { "where": { "age": { "gte": 30 } }, "orderBy": [{ "createdAt": "desc" }] }
```

---

## Table of contents

- [Features](#features)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [Quick start](#quick-start)
- [HTTP methods](#http-methods)
- [Filtering](#filtering)
  - [Operators](#operators)
  - [Logical groups, relations, JSON](#logical-groups-relations-json)
  - [RSQL and OData](#rsql-and-odata)
- [Sorting, selection, includes](#sorting-selection-includes)
- [Pagination](#pagination)
- [Routes: list, count, aggregate, group-by](#routes)
- [Output formats](#output-formats)
- [Configuration](#configuration)
- [Security](#security)
- [Performance](#performance)
- [Error handling](#error-handling)
- [Migrating from 0.x (legacy)](#migrating-from-0x-legacy)
- [How it works](#how-it-works)
- [License](#license)

---

## Features

- 🔎 **Prisma-native filtering** — the query mirrors Prisma's `where`, coerced and
  validated against your schema (DMMF). Nothing Prisma can express is lost.
- 🧬 **Multiple input protocols** — bracket query strings, JSON bodies, **RSQL/FIQL**
  and **OData `$filter`**, all producing the same query.
- 🌐 **GET, QUERY & POST** — including the new safe/idempotent [`QUERY`](https://www.ietf.org/archive/id/draft-ietf-httpbis-safe-method-w-body-02.html) method (body-based search).
- 🧮 **Full grammar** — `eq/ne/gt/gte/lt/lte/in/notIn/contains/startsWith/endsWith/mode/isNull`,
  `AND`/`OR`/`NOT`, relation `some/every/none/is/isNot`, and JSON path filters.
- 🍃 **MongoDB embedded documents** — filter inside composite `type` blocks at any
  depth; `is`/`some` wrappers are inserted for you.
- 📊 **Aggregations** — `count`, `aggregate` (`sum`/`avg`/`min`/`max`) and `group-by`.
- 📄 **Pagination** — offset (`page`/`limit`) and **cursor** (`cursor=`), with links.
- 🎨 **Output formats** — HAL (default), plain, JSON:API and CSV, with content negotiation.
- 🛡️ **Security** — field/relation allow-lists, **hidden fields that never reach the
  response**, **strict deny-by-default mode**, nesting guard.
- 🔤 **Renameable keywords** — a column called `fields` or `sort`? Rename the control parameter.
- 🧩 **Framework-agnostic** — Express, **Fastify** and **Hono** bindings (neither is a dependency).
- 🚀 **Fast** — O(1) schema lookups, single-pass parsing, optional query-plan cache, telemetry.
- 🔁 **Backward compatible** — the original middleware still ships and works unchanged.
- 📦 **Typed** — full TypeScript definitions, declared separately in `*.d.ts`.

📚 **[Full documentation →](./docs/README.md)** — guides, query reference and UML diagrams.

---

## Compatibility

Every combination below is exercised in CI on each push
([`ci.yml`](.github/workflows/ci.yml)).

| | Supported | Verified in CI |
|---|---|---|
| **Node.js** | `20` · `22` · `24` (the three current LTS lines) | full suite on each |
| **Prisma** | `5` · `6` · `7` | unit + integration on all; end-to-end on 5 and 6 |
| **Express** | `4` · `5` | full suite on both |
| **Fastify** | `4` · `5` | binding suite (not a dependency) |
| **Hono** | `4` | binding suite (not a dependency) |
| **TypeScript** | `5.x` | build emits CJS + ESM + `.d.ts` |

<details>
<summary><b>Notes on version differences</b></summary>

- **Express 4 vs 5** — Express 5 changed the default query parser to the flat one, which
  would break bracket notation. The engine parses the query string itself, so both work
  with no configuration. *(Only the deprecated 0.x middleware, if you mount it directly,
  needs `app.set('query parser', 'extended')` on Express 5.)*
- **Prisma 7** — Prisma 7 moved the datasource URL out of `schema.prisma` into
  `prisma.config.ts` and requires a driver adapter. That is a Prisma-level requirement of
  *your* app; this library reads `Prisma.dmmf`, which is unchanged, so it works on 5, 6
  and 7 alike.
- **Fastify + `QUERY`** — register the method once before binding:
  `fastify.addHttpMethod('QUERY', { hasBody: true })`.
- **JSON filtering** — advanced JSON filters are only supported by PostgreSQL and MySQL
  (a Prisma limitation). The JSON `path` format is detected from your datasource.

</details>

### Peer dependencies

| Package | Range |
|---|---|
| `@prisma/client` | `>= 5.0.0` |
| `express` | `>= 4.0.0` |

Generate your Prisma Client (`npx prisma generate`) — the engine reads field and
relation metadata from `Prisma.dmmf` at runtime.

---

## Installation

```bash
npm install @didactika/prisma-autoread
npm install @prisma/client express   # peer dependencies
```

---

## Quick start

```ts
import express, { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAutoRead } from '@didactika/prisma-autoread';

const prisma = new PrismaClient();
const app = express();
const router = Router();

createAutoRead({
    model: 'User',
    delegate: prisma.user,               // enables list + count + aggregate + group-by
    methods: ['GET', 'QUERY'],
    routes: ['list', 'count'],
    searchable: ['firstName', 'lastName', 'email'],
}).applyTo(router);

app.use('/users', router);

// Format thrown errors (they carry `.status`).
app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(3000);
```

`GET /users` now supports filtering, sorting, selection, includes, search and
pagination; `GET /users/count` counts with the same filter.

---

## HTTP methods

Set `methods` to choose the transports:

| Method | Input | Notes |
|---|---|---|
| `GET` | query string | Simple, cacheable, linkable. Default. |
| `QUERY` | JSON body | Safe & idempotent method with a body — for complex queries. |
| `POST` | JSON body | Fallback for clients/proxies that don't speak `QUERY`. |

`GET` reads a filter dialect (see below); `QUERY`/`POST` read a Prisma-shaped body:

```jsonc
// QUERY /users
{
  "where":   { "age": { "gte": 30 }, "OR": [{ "active": true }, { "age": { "lt": 18 } }] },
  "orderBy": [{ "createdAt": "desc" }],
  "select":  { "id": true, "firstName": true },
  "page": 1, "limit": 20
}
```

---

## Filtering

On `GET` with `legacy: false`, the filter lives under `filter[…]` and mirrors Prisma:

```
GET /users?filter[age][gte]=30
GET /users?filter[firstName][contains]=Al&filter[firstName][mode]=insensitive
GET /users?filter[id][in]=1,2,3
```

Values are coerced to the column type from your schema; unknown fields return `400`.

### Operators

| Alias | Prisma | | Alias | Prisma |
|---|---|---|---|---|
| `eq` / `equals` | `equals` | | `contains` | `contains` |
| `ne` / `not` | `not` | | `startsWith` / `sw` | `startsWith` |
| `gt` `gte` `lt` `lte` | same | | `endsWith` / `ew` | `endsWith` |
| `in` | `in` | | `mode` | `mode` |
| `nin` / `notIn` | `notIn` | | `isNull` | `equals: null` / `not: null` |

A bare list is treated as `in`: `filter[id]=1,2` → `{ id: { in: [1, 2] } }`.

### Logical groups, relations, JSON

```
# OR / AND / NOT
GET /users?filter[or][0][active]=true&filter[or][1][age][lt]=18
→ { OR: [ { active: true }, { age: { lt: 18 } } ] }

# Relations (to-many auto-wrapped in `some`; explicit some/every/none/is/isNot supported)
GET /users?filter[posts][some][title][startsWith]=Hello
GET /orders?filter[customer][email][contains]=@corp

# MongoDB embedded documents (composite `type` blocks), wrapped in `is` / `some`
GET /course-schedules?filter[program][shortname]=MAT
→ { program: { is: { shortname: 'MAT' } } }
GET /course-schedules?filter[program][subjects][type]=lab
→ { program: { is: { subjects: { some: { type: 'lab' } } } } }

# JSON columns (Prisma-native path filter)
GET /users?filter[metadata][path][0]=theme&filter[metadata][equals]=dark
```

### RSQL and OData

With `legacy: false` the GET dialects are auto-detected by shape, so these all work
on the same endpoint:

```
# RSQL / FIQL  (; = AND, , = OR, * = wildcard)
GET /users?filter=age=ge=30;name==Al*
GET /users?filter=active==true,age=lt=18
GET /users?filter=role=in=(admin,editor)

# OData $filter
GET /users?$filter=age gt 30 and startswith(name,'Al')
GET /users?$filter=active eq true or age lt 18
GET /users?$orderby=age desc&$select=id,name&$top=20&$skip=40
```

Restrict the accepted dialects with `formats: ['query']` (or `['query','rsql']`, …).

---

## Sorting, selection, includes

```
GET /users?sort=-createdAt,lastName     → orderBy: [{ createdAt: 'desc' }, { lastName: 'asc' }]
GET /users?fields=id,firstName,email     → select: { id, firstName, email }
GET /users?include=posts[comments]       → include posts with nested comments
GET /users?distinct=email                → distinct: ['email']
GET /users?search=alice                  → OR-contains across `searchable` fields
```

> `fields` (select) and `include` are mutually exclusive in Prisma — if both are
> given, `select` wins.

Every relation in `include` also accepts `where`, `orderBy`, `take`, `skip` and
`select` — the same controls Prisma itself takes, so a nested collection can be
filtered, sorted and bounded independently of the root query:

```
GET /users?include[posts][take]=20&include[posts][where][published]=true&include[posts][orderBy][createdAt]=desc
```

```jsonc
// equivalent JSON body
{ "include": { "posts": { "where": { "published": true }, "orderBy": [{ "createdAt": "desc" }], "take": 20 } } }
```

`take`/`skip`/`orderBy` are rejected with `400` on a to-one relation. A to-many
relation with no explicit `take` is bounded automatically at `defaults.limit` — see
[docs/performance.md](./docs/performance.md#the-include-row-budget--on-by-default)
for the row budget that applies to the whole tree, and how to size or disable it.

---

## Pagination

**Offset** (default):

```
GET /users?page=2&limit=20
```

**Cursor** — pass the last id you saw; the response echoes the next one in
`pagination.nextCursor` and a `next` link:

```
GET /users?limit=20&cursor=42
```

A cursor is a **row identifier, not a row number**: `cursor=42` means "start after
the row with id 42", not "start at row 42" — for that, use `page`/`limit`. Follow
`next` until it disappears: on the last page `nextCursor` is absent and `hasNext` is
`false`. The value is validated against the id column, so a wrong-typed cursor
(including a malformed MongoDB `@db.ObjectId`) returns `400` naming the problem
instead of a driver error. Page by another unique column with `?cursor[uuid]=…`.

---

## Routes

`routes` accepts a short form or a map with custom paths:

```ts
routes: ['list', 'count', 'aggregate', 'groupBy']
routes: { list: true, count: { path: '/total' } }
```

| Route | Prisma | Default path | Example |
|---|---|---|---|
| `list` | `findMany` (+ `count`) | `/` | `GET /users?filter[active]=true` |
| `count` | `count` | `/count` | `GET /users/count?filter[active]=true` → `{ "count": 12 }` |
| `aggregate` | `aggregate` | `/aggregate` | `GET /users/aggregate?avg=age&count=true` |
| `groupBy` | `groupBy` | `/group-by` | `GET /users/group-by?by=role&count=true` |

Aggregation params: `sum`, `avg`, `min`, `max` (field lists) and `count` (`true` or a
field list); group-by adds `by` and an optional Prisma-native `having`.

---

## Output formats

`hal` (default), `plain`, `jsonapi` and `csv` are built in. Pick a default with
`output`, or let clients negotiate:

```
GET /users?format=csv
GET /users            (Accept: application/vnd.api+json)   → JSON:API
```

---

## Configuration

```ts
createAutoRead(options): { applyTo(router): Router }
```

| Option | Required | Default | Description |
|---|:---:|---|---|
| `model` | ✅ | — | Prisma model name (schema casing). |
| `delegate` | ✅* | — | Prisma model delegate (`prisma.user`). Enables all routes. |
| `findByFilter` | ✅* | — | Legacy-style callback, alternative to `delegate`. *One of the two. |
| `methods` | | `['GET']` | HTTP methods to expose. |
| `routes` | | `['list']` | Routes to generate (short form or per-route path map). |
| `output` | | `'hal'` | Default output format. |
| `legacy` | | `true` | `true` = old GET syntax; `false` = modern dialects. |
| `formats` | | all | GET dialects when `legacy: false` (`query`/`rsql`/`odata`). |
| `searchable` | | `[]` | Fields scanned by `?search=`. |
| `defaults` | | `{limit:10,maxLimit:100,sort:'id',order:'asc'}` | Pagination/sort defaults. |
| `security` | | allow all | `{ fields, relations, hidden, maxDepth, maxRelationRows, maxFanout, maxInValues, maxOrBranches }`. |
| `keywords` | | defaults | Rename reserved query params (see below). |
| `provider` / `jsonPathSyntax` | | auto | JSON `path` syntax; auto-detected from the datasource. |
| `cache` | | off | `true` or `{ max }` — cache parsed query plans. |
| `onQuery` | | — | Telemetry hook `(t) => void` with per-request timings + `estimatedRows`. |
| `onRecommendation` | | — | Opt-in query-shape advisory hook `(r) => void`. See [Performance](./docs/performance.md#query-shape-recommendations). |
| `relationLoadStrategy` | | — | `'join'` \| `'query'`, forwarded to Prisma when `include` is used. Requires the `relationJoins` preview feature. See [Performance](./docs/performance.md#batching-relation-loads-relationloadstrategy). |
| `basePathPrefix` | | `''` | Prefix inserted into generated links. |

### Renaming reserved parameters

If a column collides with a control parameter, rename the control — globally once, or
per endpoint:

```ts
import { Keywords } from '@didactika/prisma-autoread';

Keywords.configure({ fields: 'select', filter: 'q' });   // global, once at bootstrap
createAutoRead({ /* … */, keywords: { limit: 'size' } }); // per endpoint
```
```
GET /users?q[age][gte]=30&select=id,firstName&size=20
```

### Frameworks

```ts
createAutoRead({ … }).applyTo(expressRouter);   // Express
createAutoRead({ … }).applyToFastify(fastify);  // Fastify
createAutoRead({ … }).applyToHono(honoApp);     // Hono
```

Fastify and Hono are typed structurally, so neither is a dependency. See
[docs/frameworks.md](./docs/frameworks.md).

---

## Security

```ts
createAutoRead({
    model: 'User',
    delegate: prisma.user,
    security: {
        fields: ['id', 'firstName', 'email'], // only these are filterable/sortable/selectable
        relations: ['posts'],                 // only these can be traversed/included
        hidden: ['password', 'resetToken'],   // never queryable AND never returned
        maxDepth: 5,                          // reject deeply-nested filters
        maxRelationRows: 100,                 // cap + auto-default `take` per relation in `include`
        maxFanout: 5000,                      // reject an `include` tree estimated above this many rows
    },
});
```

`maxRelationRows` is on by default (`defaults.limit` unless set): a to-many relation
in `include` with no explicit `take` is bounded even without touching `security` at
all. Set it to size it deliberately, or to `Infinity` to restore a fully unbounded
relation — see [docs/security.md](./docs/security.md#row-budgets-for-include--on-by-default)
and [docs/performance.md](./docs/performance.md#the-include-row-budget--on-by-default).

Anything outside the allow-list returns `400`. Omit `security` (or use `'*'`) to allow
everything. The policy applies to every dialect, the legacy one included.

`fields` limits what a client may **ask for**; it does not change what Prisma returns.
For columns that must never leave the server — hashes, tokens, internal flags — use
`hidden`: those are stripped from every response (including rows reached through
`include`, `include=*` or an embedded document) and rejected in filters, sorts,
`fields`, `distinct`, `group-by` and aggregations, worded as if the field did not
exist. Dotted paths reach inside: `hidden: ['posts.draftNotes']`.

---

## Performance

- **DMMF metadata** is cached per model as maps → O(1) field/relation lookups.
- **Single-pass** parsing builds the Prisma `where` directly.
- **`cache: true`** memoises parsed query plans by request signature (parsing only —
  the database is always queried).
- **`onQuery`** gives you `{ route, format, method, parseMs, execMs, cacheHit }`.
- `list` reuses its `where` for the parallel `count`.

---

## Error handling

Errors carry a `.status`; register an error handler after your routes:

```ts
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
```

| Situation | Status |
|---|---|
| Unknown/again-disallowed field, bad operator, malformed RSQL/OData | `400` |
| A backlog capability invoked before it exists | `501` |

An empty result is **not** an error (`200` with `data: []`).

---

## Migrating from 0.x (legacy)

The original middleware still ships and behaves exactly as before:

```ts
import { AutoReadMiddleware, FilterMiddleware } from '@didactika/prisma-autoread';
router.use(FilterMiddleware.processQueryFilters('User'));
AutoReadMiddleware.applyToRouter(router, { modelName: 'User', findByFilter });
```

To adopt the new engine while keeping the **old GET query syntax**, just declare it
with `createAutoRead({ ..., legacy: true })` (the default). When you're ready for the
modern grammar, set `legacy: false`. `QUERY`/`POST` bodies are always Prisma-native.

---

## How it works

```
HTTP (GET | QUERY | POST)
  → Binding          (Express / Fastify / Hono)
    → EndpointController   (framework-agnostic pipeline)
      → InputAdapter       (query / rsql / odata / json / legacy)
        → QueryBuilder     (validate + coerce + map operators, DMMF- and security-aware)
          → QuerySpec      (neutral, Prisma-shaped plan)
            → Route        (list / count / aggregate / group-by)
              → Executor   (findMany / count / aggregate / groupBy)
                → OutputAdapter (hal / plain / jsonapi / csv)
```

Every input protocol produces the same `QuerySpec`, and every output format consumes
the same result — so adding a protocol, format, route or framework is a self-contained
class plus one registration.

---

## Documentation

Full docs live in **[`docs/`](./docs/README.md)**:

| Guides | Internals |
|---|---|
| [Getting started](./docs/getting-started.md) · [Configuration](./docs/configuration.md) · [Query language](./docs/query-language.md) | [Architecture](./docs/ARCHITECTURE.md) |
| [Protocols](./docs/protocols.md) · [Output formats](./docs/output-formats.md) · [Routes](./docs/routes.md) | [UML diagrams](./docs/diagrams/README.md) — context, containers, domain model, use cases, classes, sequences, state |
| [Keywords](./docs/keywords.md) · [Security](./docs/security.md) · [Performance](./docs/performance.md) | |
| [Frameworks](./docs/frameworks.md) · [Migration from 0.x](./docs/migration.md) | |

**[14 runnable examples →](./examples/README.md)** — from a five-line endpoint to a
complete API, covering every framework, protocol and output format.

---

## Contributors

Thanks to everyone who has contributed to this project:

[![Contributors](https://contrib.rocks/image?repo=didactika/prisma-autoread)](https://github.com/didactika/prisma-autoread/graphs/contributors)

Want to help? Read [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

[MIT](LICENSE) — © [Didactika](https://github.com/didactika)
