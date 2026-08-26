# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-25

Row-budget controls for deep/wide `include` trees — on by default this time, not
just available — plus a query-shape advisory hook and opt-in relation-load batching.
Read *Changed* before upgrading: this release caps a to-many relation's rows by
default where 1.1.x always returned every row.

### Added

- **Per-relation `where`/`orderBy`/`take`/`skip`/`select` inside `include`.** Nested
  collections could previously only be turned on (`include: { posts: true }`) —
  there was no way to bound, filter or sort them independently of the root query.
  Now every relation accepts the same controls Prisma itself does:

  ```jsonc
  { "include": {
      "posts": {
        "where": { "published": true },
        "orderBy": [{ "createdAt": "desc" }],
        "take": 20,
        "include": { "comments": { "take": 5 } }
      }
  } }
  ```

  Same shape over the query string: `include[posts][take]=20&include[posts][where][published]=true`.
  `take`/`skip`/`orderBy` on a to-one relation are rejected with `400` (Prisma has
  no concept of paging a single record).

- **`security.maxFanout`** (default `5000`, always on) — rejects an `include` tree
  whose estimated row count (root `take` multiplied down every relation whose row
  count is known — which, by default, is every relation) exceeds the budget, before
  Prisma ever runs it.
- **`security.maxInValues`** (default `1000`) and **`security.maxOrBranches`**
  (default `50`, always on) — cap the size of an `in`/`notIn` list and the branch
  count of an `OR`/`AND` array. Both are generous enough that no existing filter
  should hit them.
- **`QuerySpec.estimatedRows`** / **`QueryTelemetry.estimatedRows`** — the row
  estimate used by `maxFanout`, surfaced through `onQuery` for dashboards.
- **`onRecommendation`** — a new opt-in hook, independent of `onQuery`, that
  analyses each request's own already-built plan against this endpoint's `security`
  config and reports query-shape findings: a relation explicitly opted out of the
  row budget, an estimate close to `maxFanout`, a large `in` list, a wide `OR`, an
  unindexed `contains`, deep offset pagination that should be a cursor instead, and
  a composite-index suggestion (`CREATE INDEX …`, skipped on MongoDB) synthesised
  from the fields a request actually filters and sorts on. Computed only when the
  hook is provided — nothing is measured against the database, and nothing is
  aggregated across requests, so there is no new state to bound or leak. Never
  reaches the HTTP response.
- **`relationLoadStrategy`** (top-level option, `'join'` | `'query'`) — forwarded to
  Prisma's `findMany` whenever `include` is present, for endpoints whose schema has
  `previewFeatures = ["relationJoins"]` enabled and want to pin the relation-loading
  strategy explicitly. Opt-in and inert otherwise: without the preview feature,
  Prisma rejects the argument, so it is never sent unless you set it. (Without this
  option at all, Prisma already loads relations via a second batched `WHERE IN`
  query rather than a raw join or one query per row — this only matters once you
  have opted into `relationJoins` yourself.)

### Changed

- **A to-many relation in `include` with no explicit `take` is now capped at
  `defaults.limit` (`10` unless configured), instead of returning every matching
  row.** This is `security.maxRelationRows`, and it is the one budget in this
  release that is on by default rather than opt-in — the whole point of the row
  budget is a parent with many children no longer fans out unbounded by default. An
  explicit `take` on a relation is capped the same way. Set
  `security.maxRelationRows` to size it deliberately, or to `Infinity` to restore
  the old unbounded behaviour for a given endpoint.

  **Upgrading:** audit any endpoint whose clients rely on an included collection
  coming back in full, and set `security.maxRelationRows: Infinity` there (or a
  number large enough for your data) before upgrading. Everything else about
  `include` is unchanged.

### Documentation

- `docs/performance.md` and `docs/security.md` cover the new default row budget,
  the nested `include` controls, `relationLoadStrategy` and `onRecommendation`,
  each with an explicit upgrade note where behaviour changed.

## [1.1.2] - 2026-07-29

Makes the cursor error say what a cursor *is*. No API changes.

### Fixed

- **The cursor error blamed a field the client never named.** `?cursor=1` answered
  `Invalid value '1' for field 'id'`, which reads as a complaint about a filter
  nobody wrote and leaves the actual mistake unsaid. A cursor is a **row identifier,
  not a row number** — `cursor=1` means "start after the row whose id is 1", not
  "start at row 1" — and that is the usual misreading. The message now leads with the
  cursor, says so, and points at `page`/`limit` for positional paging:

  ```
  Invalid cursor '1': a cursor is the 'id' of the last row you saw
  (see pagination.nextCursor), not a row number, and 'id' expects a
  24-character hex ObjectId. For positional paging use page and limit instead.
  ```

  Filter errors still name the field — there the client *did* name it.

- A cursor that does not fit a numeric or date id is rejected too. Coercion is
  best-effort, so `?cursor=abc` on an `Int` id still handed the raw string to Prisma,
  which answered with a validation error of its own. Closes the half of 1.1.1's fix
  that only covered datasource-native types.
- The "no `id` field" message now suggests the object form (`cursor[uuid]=…`), which
  is how you page by any other unique column.

### Documentation

- README, `query-language.md` and `performance.md` now state up front that a cursor
  is a row identifier rather than a position, show the `?cursor[uuid]=…` form, and
  contrast both with `page`/`limit`. The parameter behaved this way all along; nothing
  said so plainly enough.

## [1.1.1] - 2026-07-29

Cursor pagination fixes. No API changes; upgrading is a drop-in.

### Fixed

- **A malformed cursor reached the driver unchecked.** The cursor was the one input
  the engine passed to Prisma without coercing or validating it. Every value is now
  checked against the id column, so `?cursor=2` returns `400` instead of a
  `PrismaClientKnownRequestError` thrown from inside `dist/index.js`. This bit hardest
  on MongoDB, where an `@db.ObjectId` id is a plain `String` in the DMMF and only the
  driver knew better (`Malformed ObjectID: … got "2", length 1`).
- **`@db.ObjectId` values are validated everywhere**, not only in the cursor:
  `?filter[id]=2`, `[in]`, `[not]` and any other whole-value operator now return
  `400 Invalid value '2' for field 'id': expected a 24-character hex ObjectId`.
  Fragment operators (`contains`, `startsWith`, `endsWith`) are exempt by design.
  `FieldMeta` carries the datasource-native type for this.
- **Exhausted cursor pages lied.** Cursor mode was inferred from `nextCursor`, which is
  absent on the last page, so the response silently fell back to offset semantics and
  reported `hasNext: true` with `first`/`last`/`next` *page* links — pointing a client
  straight back into a stream it had already finished. `OutputContext.cursorMode` now
  states the mode explicitly: the last page reports `hasNext: false` and emits no
  `next` link. A cursor pointing past the end (or at a deleted row) still returns an
  empty page rather than an error, which is Prisma's own behaviour.
- `?cursor[id]=…` (the object form) is coerced too; it used to pass the raw string
  through. Compound-unique cursors keep passing through untouched.
- Cursor pagination on a model without an `id` field now explains itself instead of
  sending `{ id: undefined }` to Prisma.

### Changed

- `OutputContext` gained the optional `cursorMode`. Custom output adapters keep
  working; they fall back to the old inference when it is absent.
- `ValueCoercer` gained `field()` / `fieldList()`, which coerce *and* check the native
  type. `scalar()` and `list()` are unchanged, so existing callers are unaffected.

## [1.1.0] - 2026-07-29

Hidden fields and MongoDB embedded documents, plus a security policy that finally
covers every dialect.

### Added

- **`security.hidden`** — fields that are never queryable **and** never returned.
  `security.fields` only limits what a client may ask for; Prisma still returns every
  column, so a field left out of the allow-list was still visible in the response.
  A hidden field is stripped from every payload after execution — no matter whether
  the row came from a plain `findMany`, a `select`, an `include`, `include=*`, an
  embedded document or the CSV output — and is rejected on the way in for filters,
  sorts, `fields`, `distinct`, `group-by` and aggregations. The rejection is worded
  exactly like an unknown field, and hidden names are removed from the
  `Available fields: …` hint, so the endpoint cannot be used to probe for sensitive
  columns. `?search=` silently drops them too.

  Paths are dotted and case-insensitive, reaching into relations and composite types:
  `hidden: ['password', 'enrolments.internalNote', 'program.subjects.uuid']`.

- **MongoDB composite types (embedded documents)** are now first-class. A `type` block
  lives in `datamodel.types`, not `datamodel.models`, so any filter that crossed into
  one failed with `Model 'Program' not found in Prisma schema`. Composite fields are
  now recognised as their own kind of field and filtered with Prisma's composite
  operators, with the right wrapper inserted automatically:

  ```
  ?filter[program][shortname]=MAT     → { program: { is: { shortname: 'MAT' } } }
  ?filter[program][subjects][type]=lab → { program: { is: { subjects: { some: { type: 'lab' } } } } }
  ```

  Nesting is unlimited, sub-fields are validated against the composite type and
  coerced to their declared type, and the explicit operators (`is`, `isNot`, `equals`,
  `isSet` for a single document; `some`, `every`, `none`, `equals`, `isEmpty`, `isSet`
  for a list) can be written by hand. `fields=program` projects the whole document.
  The legacy GET syntax (`?program[shortname]=MAT`, including `LIKE`/`STARTS_WITH`/
  `ENDS_WITH`) gets the same treatment.

- `FieldMask`, `SpecGuard` and `CompositeWhereNormalizer` are exported, along with the
  `MaskNode` and `CompositeMeta` types. `ModelMeta` gained `composite()` /
  `compositeNames()`, and `DmmfRegistry` gained `composite()` / `compositeTypeNames()`.
- Example [15-mongodb-embedded](./examples/15-mongodb-embedded).

### Fixed

- **Security policies were ignored on the legacy dialect.** `legacy: true` (the
  default) drives the frozen 0.x middleware, which never saw `security`, so
  `fields`/`relations` allow-lists applied to every protocol *except* the default one.
  The captured query plan is now validated against the same policy before execution.
- `include=*` no longer crashes on MongoDB: composite fields were emitted into Prisma's
  `include`, which rejects them. They are skipped now (embedded documents always come
  back with the row), as is an explicitly named composite.
- Values inside embedded documents are coerced on the legacy path too — a `DateTime`
  in a composite type used to reach Prisma as a raw string.
- `Model '…' not found` is now distinguished from `Composite type '…' not found`.

### Changed

- `ModelMetadata` gained `isComposite`, `composite()` and `compositeNames()`. Custom
  implementations of that interface (rare — it is normally produced by `DmmfRegistry`)
  need the three new members.

### Upgrading

Behaviour is unchanged unless you set `security` together with `legacy: true`, where
allow-lists now do what they always said they did. If a client legitimately needs a
field that is missing from `security.fields`, add it; consider moving anything you
never want returned into the new `security.hidden`.

## [1.0.0] - 2026-07-22

First stable release. A new, layered search engine sits alongside the original
middleware, which is preserved unchanged for backward compatibility.

### Added

- **`createAutoRead(options).applyTo(router)`** — declarative endpoint factory.
- **HTTP methods**: `GET` (query string), `QUERY` (JSON body, safe & idempotent),
  and `POST` (body fallback), dispatched on the same routes.
- **Input protocols**:
  - `query` — Prisma-native bracket syntax (`filter[age][gte]=30`).
  - `json` — Prisma-shaped body (`{ "where": … }`) for `QUERY`/`POST`.
  - `rsql` — RSQL/FIQL string filters (`filter=age=ge=30;name==Al*`).
  - `odata` — OData `$filter` (`$filter=age gt 30 and startswith(name,'Al')`).
  - `legacy` — the original GET syntax, reusing the frozen middleware verbatim.
- **Operators**: `eq/equals`, `ne/not`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`,
  `contains`, `startsWith`, `endsWith`, `mode`, `isNull`; logical `AND`/`OR`/`NOT`;
  relation `some`/`every`/`none`/`is`/`isNot`; JSON path filters.
- **Routes**: `list`, `count`, `aggregate` (`_sum`/`_avg`/`_min`/`_max`/`_count`) and
  `group-by`, each with a configurable path.
- **Selection & sorting**: `fields`→`select`, multi-field `sort=-a,b`, `include`,
  `distinct`.
- **Pagination**: offset (`page`/`limit`) and cursor (`cursor=`), with HAL links.
- **Output formats**: `hal` (default), `plain`, `jsonapi`, `csv`, with content
  negotiation via `?format=` or the `Accept` header.
- **Frameworks**: Express, **Fastify** and **Hono** bindings on top of a
  framework-agnostic `EndpointController`. Neither Fastify nor Hono is a dependency —
  both are typed structurally.
- **Security**: field/relation allow-lists, a `maxDepth` guard, and a **strict
  deny-by-default mode** that refuses to start without an explicit allow-list.
- **Renameable keywords**: every reserved query parameter (`filter`, `fields`, `sort`,
  `page`, `limit`, …) can be renamed globally via `Keywords.configure()` or per endpoint
  via `keywords`, so a column can share a name with a control parameter.
- **Datasource-aware JSON paths**: the provider is auto-detected from the Prisma client
  and the JSON `path` is normalised to `array` (PostgreSQL/SQLite/…) or `string`
  (MySQL/MariaDB); overridable with `provider` / `jsonPathSyntax`.
- **Performance**: cached DMMF metadata (O(1) lookups), single-pass parsing, an
  optional query-plan cache, and an `onQuery` telemetry hook.
- Full TypeScript types for the public surface.
- Documentation set under `docs/` with guides and UML diagrams (context, containers,
  domain model, use cases, classes, sequences, components, state).

### Changed

- Repository restructured into a conventional library layout (`core/`, `input/`,
  `output/`, `routes/`, `http/`, `config/`, `errors/`, `legacy/`).
- The engine is object-oriented throughout: adapters, parsers, routes, registries,
  builders and resolvers are classes with a single responsibility.
- All type declarations were moved out of implementation files into `src/types/*.d.ts`
  and are imported with `import type`.

### Deprecated

- `AutoReadMiddleware`, `FilterMiddleware`, `PaginationMiddleware` and the legacy
  parsing utilities. They remain fully supported (and are still used under the hood
  by `legacy: true`), but new code should prefer `createAutoRead`.

### Fixed

- **Express 5 compatibility**: Express 5 changed the default query parser to the flat
  one, which broke bracket notation. The engine now parses the query string itself in
  every binding, so Express 4 and 5 (and Fastify and Hono, whose parsers are flat too)
  behave identically with no configuration. The parser also guards against prototype
  pollution and caps parameter count and depth.

### Compatibility

- Verified in CI: **Node 20/22/24**, **Prisma 5/6/7**, **Express 4/5**, plus the
  Fastify and Hono bindings.
- `peerDependencies` widened to `@prisma/client >= 5.0.0`; `engines.node >= 20` added.
- The deprecated 0.x middleware, when mounted directly on Express 5, needs
  `app.set('query parser', 'extended')`. Using it through `createAutoRead({ legacy: true })`
  needs no such change.

### Notes

- JSON path filtering is only supported by PostgreSQL and MySQL (per Prisma). The
  `Json` path format is detected from the datasource provider.
