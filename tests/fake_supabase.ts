// Minimal in-memory fake of the subset of the supabase-js query builder that
// _shared/*.ts actually uses (select/insert/update, eq/in/lt, order,
// single/maybeSingle). Mirrors the old Vitest suite's approach of mocking
// Prisma with an in-memory fake instead of hitting a real database — there is
// no live Supabase/Postgres available in this environment to test against.

type Row = Record<string, unknown>;

type OrCondition = { col: string; op: "is" | "lt"; value: unknown };

type Filter =
  | { type: "eq"; col: string; value: unknown }
  | { type: "neq"; col: string; value: unknown }
  | { type: "in"; col: string; values: unknown[] }
  | { type: "lt"; col: string; value: unknown }
  | { type: "is"; col: string; value: unknown }
  | { type: "not_is"; col: string; value: unknown }
  | { type: "or"; conditions: OrCondition[] };

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.type === "eq" && row[f.col] !== f.value) return false;
    if (f.type === "neq" && row[f.col] === f.value) return false;
    if (f.type === "in" && !f.values.includes(row[f.col])) return false;
    if (f.type === "lt" && !(String(row[f.col]) < String(f.value))) return false;
    // Mirrors Postgres IS NULL semantics: undefined (never set) counts as null too.
    if (f.type === "is" && !(f.value === null ? row[f.col] == null : row[f.col] === f.value)) return false;
    if (f.type === "not_is" && (f.value === null ? row[f.col] == null : row[f.col] === f.value)) return false;
    if (f.type === "or") {
      const anyMatch = f.conditions.some((c) => {
        if (c.op === "is") return c.value === null ? row[c.col] == null : row[c.col] === c.value;
        if (c.op === "lt") return row[c.col] != null && String(row[c.col]) < String(c.value);
        return false;
      });
      if (!anyMatch) return false;
    }
  }
  return true;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `fake-id-${idCounter}`;
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  #table: Row[];
  #op: "select" | "insert" | "update" = "select";
  #filters: Filter[] = [];
  #insertRow: Row | undefined;
  #updatePatch: Row | undefined;
  #orderCol: string | undefined;
  #orderAsc = true;
  #singleMode: "none" | "single" | "maybeSingle" = "none";

  constructor(table: Row[]) {
    this.#table = table;
  }

  select(_cols = "*"): this {
    if (this.#op === "select") this.#op = "select";
    return this;
  }

  insert(row: Row): this {
    this.#op = "insert";
    this.#insertRow = row;
    return this;
  }

  update(patch: Row): this {
    this.#op = "update";
    this.#updatePatch = patch;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.#filters.push({ type: "eq", col, value });
    return this;
  }

  neq(col: string, value: unknown): this {
    this.#filters.push({ type: "neq", col, value });
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.#filters.push({ type: "in", col, values });
    return this;
  }

  lt(col: string, value: unknown): this {
    this.#filters.push({ type: "lt", col, value });
    return this;
  }

  is(col: string, value: unknown): this {
    this.#filters.push({ type: "is", col, value });
    return this;
  }

  // Only the "is" operator is needed by the code under test (e.g. `.not(col, "is", null)`).
  not(col: string, op: string, value: unknown): this {
    if (op !== "is") throw new Error(`FakeQueryBuilder.not: unsupported operator "${op}"`);
    this.#filters.push({ type: "not_is", col, value });
    return this;
  }

  // Parses PostgREST's `.or("col.is.null,col.lt.value")` string syntax —
  // only "is" and "lt" are needed by the code under test.
  or(filterString: string): this {
    const conditions: OrCondition[] = filterString.split(",").map((part) => {
      const [col, op, ...rest] = part.split(".");
      const raw = rest.join(".");
      if (op !== "is" && op !== "lt") throw new Error(`FakeQueryBuilder.or: unsupported operator "${op}"`);
      return { col, op, value: raw === "null" ? null : raw };
    });
    this.#filters.push({ type: "or", conditions });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.#orderCol = col;
    this.#orderAsc = opts?.ascending ?? true;
    return this;
  }

  single(): this {
    this.#singleMode = "single";
    return this;
  }

  maybeSingle(): this {
    this.#singleMode = "maybeSingle";
    return this;
  }

  #execute(): { data: unknown; error: unknown } {
    if (this.#op === "insert") {
      const now = new Date().toISOString();
      const row: Row = { id: nextId(), created_at: now, updated_at: now, ...this.#insertRow };
      this.#table.push(row);
      if (this.#singleMode === "single") return { data: row, error: null };
      return { data: [row], error: null };
    }

    if (this.#op === "update") {
      const matched = this.#table.filter((row) => matches(row, this.#filters));
      const now = new Date().toISOString();
      for (const row of matched) {
        Object.assign(row, this.#updatePatch, { updated_at: now });
      }
      if (this.#singleMode === "single") return { data: matched[0] ?? null, error: null };
      if (this.#singleMode === "maybeSingle") return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }

    // select
    let rows = this.#table.filter((row) => matches(row, this.#filters));
    if (this.#orderCol) {
      const col = this.#orderCol;
      rows = [...rows].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return this.#orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.#singleMode === "single" || this.#singleMode === "maybeSingle") {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.#execute()).then(onfulfilled, onrejected);
  }
}

export class FakeSupabaseClient {
  tables: Record<string, Row[]> = {};

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  // deno-lint-ignore no-explicit-any
  from(name: string): any {
    return new FakeQueryBuilder(this.table(name));
  }

  reset() {
    this.tables = {};
  }
}

export function makeFakeSupabase(): FakeSupabaseClient {
  return new FakeSupabaseClient();
}
