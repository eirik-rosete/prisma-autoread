# Performance

## Built in, always on

| Technique | Effect |
|---|---|
| **Cached schema metadata** | `DmmfRegistry` builds one `Map` of fields and relations per model, so every lookup is O(1) instead of scanning the DMMF. |
| **Single-pass parsing** | The Prisma `where` is produced directly while walking the request — no intermediate representation to re-expand. |
| **Shared `where`** | `list` computes the filter once and reuses it for the `count`, both issued with `Promise.all`. |
| **`count` without rows** | The count route never fetches records. |
| **`select` support** | `?fields=` narrows the columns Prisma reads and the bytes you send. |

## Query-plan cache

Parsing, validating and coercing a request is pure CPU work that repeats for identical
requests. Turn on the cache to skip it:

```ts
createAutoRead({
    model: 'User',
    delegate: prisma.user,
    cache: true,             // 500-entry LRU
    // cache: { max: 2000 },
});
```

- **Key**: HTTP method + route path + query + body.
- **Cached**: the validated `QuerySpec` only.
- **Never cached**: database results — every request still queries Prisma.
- **Safe**: a cached plan already passed schema validation and the security policy.

## Telemetry

```ts
createAutoRead({
    model: 'User',
    delegate: prisma.user,
    onQuery: ({ route, format, method, parseMs, execMs, cacheHit }) => {
        metrics.histogram('autoread.parse_ms', parseMs, { route });
        metrics.histogram('autoread.exec_ms', execMs, { route });
        if (cacheHit) metrics.increment('autoread.cache_hit');
    },
});
```

| Field | Meaning |
|---|---|
| `route` | `list` · `count` · `aggregate` · `groupBy` |
| `format` | Output format actually used |
| `method` | HTTP method |
| `parseMs` | Time to produce the query plan (≈0 on a cache hit) |
| `execMs` | Time in the database plus rendering |
| `cacheHit` | Whether the plan came from the cache |

## Cursor pagination for large datasets

Offset pagination degrades as `skip` grows. For deep or infinite scrolling use cursors:

```
GET /users?limit=50
→ pagination.nextCursor: 50
GET /users?limit=50&cursor=50
```

The engine passes `cursor` to Prisma and skips the cursor row itself.

> **A cursor is a row identifier, not a row number.** `?cursor=1` does not mean
> "start at the first row" — it means "start after the row whose id is `1`". Read the
> next one from `pagination.nextCursor` (or the `next` link) and pass it straight
> back. For positional paging — "give me rows 20 to 40" — use `page` and `limit`,
> which is what they are for.

The cursor value is coerced and validated against the id column like any other
input, so a wrong-typed one is a `400` rather than a driver error. This is where the
row-number reading usually surfaces, most visibly on MongoDB, where an id is a
24-character hex `@db.ObjectId`:

```
GET /course-schedules?cursor=1
→ 400 Invalid cursor '1': a cursor is the 'id' of the last row you saw
      (see pagination.nextCursor), not a row number, and 'id' expects a
      24-character hex ObjectId. For positional paging use page and limit instead.

GET /course-schedules?cursor=507f1f77bcf86cd799439011&limit=50   ✅
```

To page by a column other than `id` — any `@unique` one works — address it
explicitly:

```
GET /course-schedules?cursor[uuid]=8f3a…&limit=50
```

**Stopping.** Follow `next` until it disappears. On the last page `nextCursor` is
absent, `pagination.hasNext` is `false` and no `next` link is emitted — a cursor
pointing past the end is not an error, it simply returns no rows. Cursor responses
never carry `first`/`last`/`prev` links: there is no page number to jump to.

A cursor whose row was deleted meanwhile also returns an empty page rather than
failing, so a client that keeps a stale cursor degrades quietly.

## Bounding `include` — per-relation controls

A to-many relation in `include` used to be all-or-nothing: `include: { posts: true }`
fetched *every* matching row, with no way to filter, sort or cap it independently of
the root query. Every relation now accepts the same controls Prisma itself does:

```jsonc
{
  "include": {
    "posts": {
      "where": { "published": true },
      "orderBy": [{ "createdAt": "desc" }],
      "take": 20,
      "skip": 0,
      "include": { "comments": { "take": 5 } }
    }
  }
}
```

Over the query string, the same shape is a deep object:

```
GET /users?include[posts][take]=20&include[posts][where][published]=true
```

`select` at a relation level works the same as at the root: it wins over any nested
`include` for that relation. `take`/`skip`/`orderBy` are rejected with `400` on a
to-one relation — Prisma has no concept of paging a single record.

The shapes themselves are additive: an `include` that only names relations
(`{ posts: true }`, `{ posts: { comments: true } }`) still works. What *is* new is
that a to-many relation with no explicit `take` no longer comes back unbounded — see
[the row budget](#the-include-row-budget--on-by-default) below.

## The `include` row budget — on by default

The real risk in a deep `include` isn't one relation — it's several to-many
relations nested inside each other. A parent with 100 children, each with 100 of
their own, is 10,000 rows before you are three levels deep; add a fourth level and
it is a million, all from a request that looks as innocuous as `?include=posts[comments[likes]]`.

**Every to-many relation in `include` is bounded automatically, with no config
required**: a relation that doesn't specify its own `take` gets the endpoint's own
page size (`defaults.limit`, `10` unless you set it), and an explicit `take` is
capped at the same number. This is the one place this library changed a default
rather than adding an opt-in — see *Upgrading* below if you relied on an included
collection coming back whole.

```ts
createAutoRead({
    model: 'User',
    delegate: prisma.user,
    security: {
        maxRelationRows: 100,   // ceiling + default `take` per relation (defaults.limit otherwise)
        maxFanout: 5000,        // reject a plan estimated above this many total rows
    },
});
```

- **`maxRelationRows`** — defaults to `defaults.limit`, so every to-many relation is
  already bounded before you configure anything. Set it once you want a different
  size than your root page size, or set it to `Infinity` to restore a fully
  unbounded relation (per-endpoint, or — combined with `security.relations` — for a
  single relation via a stricter nested endpoint of your own).
- **`maxFanout`** (default `5000`, always on) — the root `take` multiplied down
  every relation whose row count is known — which, by default, is every relation —
  is checked against this budget, and the request is rejected with `400` before it
  ever reaches Prisma if it is exceeded. Only a relation explicitly set to
  `Infinity` is invisible to the estimate.
- **`maxInValues`** (default `1000`) / **`maxOrBranches`** (default `50`) — cap the
  size of an `in`/`notIn` list and the branch count of `OR`/`AND`. Generous enough
  that normal filters never notice them.

The same estimate is on `QuerySpec.estimatedRows` and `QueryTelemetry.estimatedRows`
(via `onQuery`) whenever an `include` is present — useful as a dashboard metric on
its own.

**Upgrading:** if an endpoint's clients rely on an included to-many relation coming
back in full, set `security.maxRelationRows: Infinity` on that endpoint (or raise it
to a number large enough for your data) before upgrading. Everything else about
`include` — the shape of what you ask for, `where`/`orderBy`/`select` per relation —
is unchanged.

## Batching relation loads (`relationLoadStrategy`)

Prisma does not turn `include` into an exploding join by default: unless your
schema opts into the `relationJoins` preview feature, every relation is already
loaded as a **second, batched query** (`WHERE parentId IN (...)`), not one query per
parent row and not a raw SQL join — this has been Prisma's only strategy for most of
its life, and it is exactly the "batch instead of join" behaviour a hand-rolled
data-loader would try to give you. Combined with the row budget above, this is why
there is no separate "use batching" switch to turn on here.

If your schema *does* have `previewFeatures = ["relationJoins"]` enabled (Postgres,
CockroachDB, MySQL), Prisma lets you pick the strategy per query. Pin it explicitly
if you want to be sure which one runs:

```ts
createAutoRead({
    model: 'User',
    delegate: prisma.user,
    relationLoadStrategy: 'query', // keep the batched behaviour explicitly
    // relationLoadStrategy: 'join', // opt into a single SQL join instead
});
```

Forwarded to `findMany` only when `include` is present, and only when you set it —
without the preview feature enabled, Prisma rejects the argument outright, so this
stays opt-in rather than a default.

## Query-shape recommendations

`onRecommendation` is an opt-in hook, independent of `onQuery` and off unless you
provide it, that analyses **this request's own plan** against the endpoint's
`security` config and reports things worth a second look:

```ts
createAutoRead({
    model: 'User',
    delegate: prisma.user,
    onRecommendation: ({ level, code, model, field, message, hint }) => {
        logger[level](`[${model}${field ? `.${field}` : ''}] ${code}: ${message} — ${hint}`);
    },
});
```

| `code` | Fires when |
|---|---|
| `unbounded-relation` | A to-many relation in `include` has no `take` — only possible once `security.maxRelationRows` is set to `Infinity` for it. |
| `fanout-near-budget` | `estimatedRows` is at or past 70% of `maxFanout`. |
| `large-in-list` | An `in`/`notIn` list is at or past half of `maxInValues`. |
| `many-logical-branches` | An `OR`/`AND` has at or past 60% of `maxOrBranches` branches. |
| `unindexed-contains` | A `contains` filter (`LIKE '%…%'`) is used — rarely servable by a plain B-tree index. |
| `deep-offset-pagination` | `skip` is 1000+ without a `cursor` — a candidate for cursor pagination instead. |
| `index-hint` | Two or more distinct fields are filtered/sorted on together — a candidate composite index, phrased as `CREATE INDEX …` (skipped for `mongodb`). |

Nothing here touches the database — no `EXPLAIN`, no table statistics — and nothing
is remembered between requests: every finding comes from this one request's already-built
plan plus the config you already set. That keeps it cheap enough to run on every
request and free of any state to bound or leak. It never reaches the HTTP response,
so an API client can never see what these hints reveal about your schema or limits.

## Tips

- Index whatever you let clients filter and sort on — the library builds the query, the
  database still needs the index.
- Keep `defaults.maxLimit` sensible; it is the only guard against `?limit=100000`.
- Prefer `fields` over `include` when the client only needs scalars.
- Set `security.maxRelationRows` explicitly once you have a sense of a sane
  per-relation page size for this endpoint, rather than leaning on the
  `defaults.limit` fallback — it is the difference between "bounded by design" and
  "bounded because nobody has picked a number yet".
- Reach for `groupBy`/`aggregate` instead of fetching rows and reducing in Node.
