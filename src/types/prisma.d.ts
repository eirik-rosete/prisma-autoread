/** The subset of a Prisma model delegate the engine relies on. */
export interface PrismaDelegate {
    findMany(args: any): Promise<any[]>;
    count(args: any): Promise<number>;
    aggregate?(args: any): Promise<any>;
    groupBy?(args: any): Promise<any[]>;
}

/** Legacy-style callback that runs the query and returns rows (+ optional total). */
export type FindByFilter = (
    args: { where?: any; include?: any; orderBy?: any; take?: number; skip?: number },
) => Promise<{ data: any[]; total?: number } | any[]>;

/**
 * Prisma's own relation-loading strategy, forwarded to `findMany` verbatim when
 * `include` is present. Requires the `relationJoins` preview feature (Postgres,
 * CockroachDB, MySQL) — passing this without it enabled makes Prisma reject the
 * query, so it is opt-in and never set unless you configure it.
 */
export type RelationLoadStrategy = 'join' | 'query';

/** Where the executor gets its data from. */
export interface ExecutorSource {
    delegate?: PrismaDelegate;
    finder?: FindByFilter;
    relationLoadStrategy?: RelationLoadStrategy;
}

/** Datasource providers recognised for JSON path syntax detection. */
export type DatasourceProvider =
    | 'postgresql'
    | 'postgres'
    | 'cockroachdb'
    | 'mysql'
    | 'mariadb'
    | 'sqlite'
    | 'sqlserver'
    | 'mongodb';
