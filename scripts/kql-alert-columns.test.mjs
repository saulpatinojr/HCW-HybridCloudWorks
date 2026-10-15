/**
 * A scheduled-query alert's measured column must be a name KQL will accept,
 * and the name the query actually produces.
 *
 * ## The failure this catches
 *
 * `azurerm_monitor_scheduled_query_rules_alert_v2` can measure a column
 * instead of counting rows: the KQL projects one value and
 * `metric_measure_column` names it. Two things about that pairing fail only
 * at APPLY, on the owner's confirmation, long after review and `validate` and
 * `plan` have all passed:
 *
 *   1. **The column name is a KQL reserved word.** `project missing = …` does
 *      not parse. Azure rejects the whole resource with
 *
 *        Query could not be parsed at 'missing' on line [5,11].
 *        A recognition error occurred in the query.
 *
 *      which names the token and the position but never says the word is
 *      reserved. Line 5 column 11 is exactly where the column name begins, so
 *      it reads as a problem with the expression that follows it.
 *
 *   2. **The two halves disagree.** A rename in the query that does not move
 *      `metric_measure_column` with it leaves a rule measuring a column that
 *      does not exist. They are matched by string and nothing else checks it.
 *
 * The first one cost a partial apply on 2026-09-08. Terraform created
 * `cosmos_export_daily_missing` and set `FEATURE_FLAG_COSMOS_EXPORT = "true"`,
 * then failed on `cosmos_export_full_missing`, leaving the Cosmos exporter
 * armed with one of its two alerts.
 *
 * Those are the Terraform addresses. The Azure resource names are built as
 * `alert-cosmos-export-{daily,full}-${var.environment}-${var.region_abbreviation}`,
 * so in production today they read `alert-cosmos-export-daily-prod-cus` and
 * `alert-cosmos-export-full-prod-cus` — which is what to search for in the
 * portal, and the second of which is the one that was absent.
 *
 * Both rules are gated on the single
 * `cosmos_export_enabled` variable precisely so that half-state cannot exist,
 * and a partial apply produced it anyway, because a `count` gate decides
 * whether Terraform ATTEMPTS a resource and has no say in whether Azure
 * accepts it.
 *
 * This is the same shape as `terraform-role-definitions.test.mjs`: a mistake
 * that passes every local gate and fails on the apply. That is what a guard
 * is for.
 *
 * ## The reserved list is MEASURED, not remembered
 *
 * Every name below was confirmed rejected by running
 * `print zzz = 1 | project <name> = 1` against the live Application Insights
 * component on 2026-09-08 and observing the request refused. Names that were
 * tried and ACCEPTED are recorded too, in `MEASURED_ACCEPTABLE`, because a
 * list of failures with no record of what passed cannot be told apart from a
 * list someone guessed at.
 *
 * IT IS NOT EXHAUSTIVE, and this file does not pretend otherwise. KQL has
 * reserved words nobody here has tried. A name absent from this list is
 * untested, not blessed — so the second assertion matters independently: it
 * holds for every rule whatever the name, and it is the one that catches a
 * rename.
 *
 * To extend the list, measure rather than reason:
 *
 *   az monitor app-insights query --app <appId> \
 *     --analytics-query "print zzz = 1 | project <candidate> = 1"
 *
 * A refusal means reserved. Add it below with the date.
 *
 * ## And a binning call must be given the constants Kusto requires (#964)
 *
 * The same shape again, one step later: a query Azure accepts at create and
 * Kusto refuses at every evaluation. `alert-timer-overdue` computed each
 * timer's last due time with `bin_at(Now - Grace, period, anchor)`, where
 * `period` and `anchor` are columns of its datatable. Kusto needs both as
 * query constants, so from its creation on 2026-10-10 every evaluation failed
 * with `SEM0040 bin_at(): failed to cast argument 2 to scalar constant`, the
 * rule's Resource Health read `Unavailable / Semantic error`, and a fire test
 * on 2026-10-15 stopped healthPulse for 95 minutes without an alert.
 * `MEASURED_CONSTANT_ARGUMENTS` below records which arguments, measured the
 * same way as the reserved words.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INFRA, MIN_TF_FILES } from './terraform-source.mjs';

/**
 * Every `.tf` file in the module, read one at a time. Until PLAT-4 (#964) this
 * read observability.tf alone, and the lab rules in lab-hybrid.tf, which
 * measure columns too, were never checked. Per file rather than one joined
 * string because `alertBlocks` ends a block at the next `resource`, and a
 * file boundary is the nearer of the two for the last rule in a file.
 */
const tfFiles = readdirSync(INFRA).filter((name) => name.endsWith('.tf'));
if (tfFiles.length < MIN_TF_FILES) throw new Error(`only ${tfFiles.length} .tf files in ${INFRA}`);
const moduleBlocks = () => tfFiles.flatMap((name) => alertBlocks(readFileSync(join(INFRA, name), 'utf8')));

/** Column names measured on 2026-09-08 to be refused by KQL. */
export const MEASURED_RESERVED = new Set([
  'and',
  'between',
  'datetime',
  'dynamic',
  'false',
  'int',
  'long',
  'missing',
  'or',
  'real',
  'string',
  'timespan',
  'true',
  'views',
]);

/**
 * Measured on the same run and ACCEPTED — the control group.
 *
 * Without these, the list above could be any collection of words. `count`,
 * `by`, `in`, `let`, `not`, `set`, `step`, `of`, `bool`, `null`, `typeof`,
 * `has`, `contains`, `matches`, `on`, `delta` and `full` were all tried and
 * all worked as column names, which is what makes the refusals meaningful.
 */
export const MEASURED_ACCEPTABLE = new Set([
  'bool',
  'by',
  'contains',
  'count',
  'delta',
  'full',
  'has',
  'in',
  'let',
  'matches',
  'not',
  'null',
  'of',
  'on',
  'set',
  'step',
  'typeof',
]);

/**
 * Split the file into one entry per scheduled-query alert resource.
 *
 * Deliberately crude: a resource block runs until the next top-level
 * `resource` keyword, which is true of this file and is checked by the
 * shape assertion below rather than assumed. A parser would be a second
 * thing to keep correct for no gain here.
 */
export function alertBlocks(source) {
  const parts = source.split(/^resource "/m).slice(1);
  return parts
    .filter((part) => part.startsWith('azurerm_monitor_scheduled_query_rules_alert_v2'))
    .map((part) => {
      const name = /^azurerm_monitor_scheduled_query_rules_alert_v2" "([^"]+)"/.exec(part);
      return { name: name ? name[1] : '(unnamed)', body: part };
    });
}

/** The value of `metric_measure_column`, or null when the rule counts rows. */
export function measuredColumn(body) {
  const match = /metric_measure_column\s*=\s*"([^"]+)"/.exec(body);
  return match ? match[1] : null;
}

/**
 * The KQL text of every `query` attribute in a block, and nothing else.
 *
 * THIS BOUNDARY IS THE WHOLE POINT, and the first version of this file did
 * not have it. `producedColumns` was run over the entire resource block, and
 * because the last pipeline segment has no trailing `|` to stop at, the match
 * ran past the end of the query and read the Terraform attributes underneath
 * it as though they were columns:
 *
 *   cosmos_export_full_missing -> ["fulls", "missing_full",
 *     "time_aggregation_method", "metric_measure_column", "operator",
 *     "threshold", "number_of_evaluation_periods", "action_groups", …]
 *
 * That is not cosmetic. `metric_measure_column` is itself in that list, so a
 * rule that measured a column called `operator` or `threshold` would have
 * satisfied the agreement assertion against a Terraform attribute rather than
 * against its own query — the exact check being claimed, quietly not
 * happening. Caught in review on PR #414.
 *
 * Both spellings this file uses are handled: the indented heredoc, and the
 * one-line quoted string that `function_response_time` and
 * `cosmos_export_daily_missing` use.
 */
export function queryTexts(body) {
  const heredocs = [
    ...body.matchAll(/query\s*=\s*<<-?([A-Za-z_]\w*)\r?\n([\s\S]*?)\r?\n[ \t]*\1\b/g),
  ].map((m) => m[2]);
  const quoted = [...body.matchAll(/query\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return [...heredocs, ...quoted];
}

/**
 * Every column name the KQL introduces, from any operator that can name one.
 *
 * `summarize` belongs here as much as `project` and `extend`, and leaving it
 * out is not a harmless omission: an earlier version matched only the latter
 * two and reported `function_response_time` as measuring a column its query
 * never produced. Two of the three measured columns in this file come from
 * `summarize`, so the narrow version would have failed on real, correct rules
 * — a guard that cries wolf gets deleted, and then the case it was written
 * for ships.
 *
 * `=(?!=)` is what separates an assignment from a comparison, so the `fulls
 * == 0` inside an `iff()` is not read as a column called `fulls`. Names after
 * a `by` are not assignments and are correctly ignored.
 */
export function producedColumns(body) {
  return queryTexts(body).flatMap((query) =>
    [...query.matchAll(/\|\s*(?:summarize|project|extend)\s+([^|]*)/g)].flatMap((segment) =>
      [...segment[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g)].map((m) => m[1])
    )
  );
}

/**
 * Arguments Kusto requires to be query constants, by function and 1-based
 * position. MEASURED on 2026-10-15 against appi-site-prod-cus-01 with
 * `print` and `datatable` queries, not read off the docs:
 *
 *   - a column as `bin_at`'s bin size:    refused, "failed to cast argument 2
 *                                         to scalar constant" (SEM0040);
 *   - a column as its fixed point:        refused, the same for "argument 3";
 *   - a `let` constant, `now()`, `now() - 3h`, `2 * 5m`, a `toscalar(...)`:
 *                                         accepted in either place.
 *
 * So the line is "no per-row value", not "a literal": anything the query can
 * evaluate once is a constant to Kusto. Microsoft's page documents the fixed
 * point as "a constant" and says nothing of the bin size
 * (https://learn.microsoft.com/kusto/query/bin-at-function); the measurement
 * says both.
 */
export const MEASURED_CONSTANT_ARGUMENTS = {
  bin_at: { 2: 'bin size', 3: 'fixed point' },
};

/**
 * Measured on the same run and ACCEPTED with a per-row column: the control
 * group. `bin()`, and `floor()`, its alias, took a column as the bin size
 * both in `extend` and in `summarize ... by`, so neither is checked. A guard
 * against a refusal Kusto does not make would reject correct queries, and a
 * guard that cries wolf gets deleted (see `producedColumns`).
 */
export const MEASURED_COLUMN_ACCEPTED = {
  bin: [2],
  floor: [2],
};

/** Words that are literals, not names, wherever they appear. */
const LITERAL_WORDS = new Set(['true', 'false', 'null', 'nan', 'inf']);

/**
 * The query's code alone: string literals emptied, `//` comments and
 * Terraform interpolations removed, so a name inside any of them is not read
 * as a column. `\"` is unescaped first, because the one-line quoted form of
 * `query` escapes the KQL's own string quotes. An interpolation renders to a
 * value before Kusto sees it, so it stands in as the literal `0`.
 */
export function kqlCode(query) {
  return query
    .replace(/\\"/g, '"')
    .replace(/\$\{[^}]*\}/g, '0')
    .replace(/@?'(?:[^'\\\n]|\\.)*'|@?"(?:[^"\\\n]|\\.)*"/g, "''")
    .replace(/\/\/[^\n]*/g, '');
}

/** Each call of `fn(` in the code, as its top-level arguments, trimmed. */
export function callArguments(code, fn) {
  const calls = [];
  for (const match of code.matchAll(new RegExp(`(?<![\\w.])${fn}\\s*\\(`, 'g'))) {
    const args = [];
    let depth = 0;
    let current = '';
    for (let i = match.index + match[0].length; i < code.length; i += 1) {
      const ch = code[i];
      if (depth === 0 && (ch === ',' || ch === ')')) {
        args.push(current.trim());
        current = '';
        if (ch === ')') break;
        continue;
      }
      if ('([{'.includes(ch)) depth += 1;
      if (')]}'.includes(ch)) depth -= 1;
      current += ch;
    }
    calls.push(args);
  }
  return calls;
}

/**
 * The names in one argument that can only be per-row values: not a function
 * being called, not a literal word, not a `let` of the same query. A literal
 * needs no list of its forms: in `datetime(2026-01-05T13:00Z)`, `45m` or
 * `1.5h` every letter follows a digit or names the function, so no name is
 * found. `\b` before the lookahead stops `datetime(` matching as `datetim`.
 */
function rowNames(argument, lets) {
  return [...argument.matchAll(/(?<![\w.])([A-Za-z_]\w*)\b(?!\s*\()/g)]
    .map((m) => m[1])
    .filter((name) => !LITERAL_WORDS.has(name) && !lets.has(name));
}

/**
 * Every argument a query passes where Kusto needs a constant and gets a
 * per-row value, one line each, naming the function, the position and the
 * names it reads. Empty when the query is fine.
 */
export function nonConstantArguments(query) {
  const code = kqlCode(query);
  const lets = new Set([...code.matchAll(/(?<![\w.])let\s+([A-Za-z_]\w*)\s*=/g)].map((m) => m[1]));
  const found = [];
  for (const [fn, positions] of Object.entries(MEASURED_CONSTANT_ARGUMENTS)) {
    for (const args of callArguments(code, fn)) {
      for (const [position, role] of Object.entries(positions)) {
        const argument = args[Number(position) - 1];
        if (argument === undefined) continue;
        const names = rowNames(argument, lets);
        if (names.length > 0) {
          found.push(
            `${fn}() argument ${position} (${role}) is \`${argument}\`, which reads ${names.join(', ')}: ` +
              'not a literal, not a let of this query'
          );
        }
      }
    }
  }
  return found;
}

describe('scheduled-query alerts in infra/', () => {
  const blocks = moduleBlocks();

  it('finds the alert rules, so a parse that silently matches nothing fails', () => {
    // Without this, every assertion below passes vacuously the day the file
    // is reorganised — the failure mode a text-matching guard actually has.
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block.name).not.toBe('(unnamed)');
  });

  it('measures a column the query actually produces', () => {
    for (const block of blocks) {
      const column = measuredColumn(block.body);
      if (!column) continue;
      expect(
        producedColumns(block.body),
        `${block.name} measures "${column}", which its KQL never projects`
      ).toContain(column);
    }
  });

  it('never names a measured column with a word KQL refuses', () => {
    for (const block of blocks) {
      for (const column of producedColumns(block.body)) {
        expect(
          MEASURED_RESERVED.has(column),
          `${block.name} projects "${column}", a reserved word — Azure rejects the rule at apply`
        ).toBe(false);
      }
    }
  });
});

describe('the query/Terraform boundary', () => {
  const blocks = moduleBlocks();

  it('reads columns out of the KQL only, never out of the HCL around it', () => {
    // The regression PR #414 was reviewed for. Before `queryTexts`, the match
    // ran off the end of the last pipeline segment and returned these as
    // columns, which let the agreement assertion be satisfied by a Terraform
    // attribute instead of by the query it is supposed to check.
    const hcl = [
      'action_groups',
      'depends_on',
      'identity_ids',
      'metric_measure_column',
      'minimum_failing_periods_to_trigger_alert',
      'number_of_evaluation_periods',
      'operator',
      'tags',
      'threshold',
      'time_aggregation_method',
      'type',
    ];
    for (const block of blocks) {
      const found = producedColumns(block.body);
      for (const attribute of hcl) {
        expect(
          found,
          `${block.name} read the HCL attribute "${attribute}" as a column`
        ).not.toContain(attribute);
      }
    }
  });

  it('still reads the columns that are really there', () => {
    // The other half. A boundary that returns nothing would pass every
    // assertion above it, so the extraction is pinned to exact values.
    const byName = Object.fromEntries(blocks.map((b) => [b.name, producedColumns(b.body)]));
    expect(byName.cosmos_export_full_missing).toEqual(['fulls', 'missing_full']);
    expect(byName.function_response_time).toEqual(['P95DurationMs']);
    expect(byName.logs_daily_cap).toEqual(['IngestedGb']);
    // From lab-hybrid.tf, which this file did not read before PLAT-4.
    expect(byName.lab_hybrid_disk_used).toEqual(['UsedPct']);
    expect(byName.lab_hybrid_ssh_burst).toEqual(['Recent', 'Earlier', 'Burst']);
  });
});

describe('binning calls get the constants Kusto requires (#964)', () => {
  const blocks = moduleBlocks();

  it('passes no per-row value where Kusto needs a constant, in any rule', () => {
    // Azure validated nothing of this at create on 2026-10-10, and nothing in
    // CI ran the KQL, so this is the only check before the rule goes silent.
    for (const block of blocks) {
      for (const query of queryTexts(block.body)) {
        expect(
          nonConstantArguments(query),
          `${block.name}: Kusto refuses this at every evaluation (SEM0040) although Azure accepts the rule at create`
        ).toEqual([]);
      }
    }
  });

  it('flags the line that kept alert-timer-overdue from evaluating from 2026-10-10', () => {
    // Pinned on its own, because once the rule is fixed no query in infra/
    // calls bin_at() and the assertion above has nothing to find.
    const query = [
      'let Grace = 45m;',
      'let Now = now();',
      'let Expected = datatable(timer: string, period: timespan, anchor: datetime) [',
      '  "healthPulse", 5m, datetime(2026-01-01 00:02)',
      '];',
      'Expected',
      '| extend lastDue = bin_at(Now - Grace, period, anchor)',
    ].join('\n');
    const found = nonConstantArguments(query);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^bin_at\(\) argument 2 \(bin size\) is `period`, which reads period:/);
    expect(found[1]).toMatch(/^bin_at\(\) argument 3 \(fixed point\) is `anchor`, which reads anchor:/);
  });

  it('accepts every form measured to work', () => {
    for (const query of [
      'print b = bin_at(now(), 5m, datetime(2026-01-01 00:02))',
      'print b = bin_at(now(), 7d, datetime(2026-01-05T13:00Z))',
      'let S = 5m; let F = datetime(2026-01-01 00:02); print b = bin_at(now(), S, F)',
      'let Now = now(); print b = bin_at(now(), 1d, Now)',
      'let S = 2 * 5m; print b = bin_at(now(), S, datetime(2026-01-01))',
      'print b = bin_at(now(), 1d, now() - 3h)',
      'print b = bin_at(6.5, 2.5, 7)',
      'datatable(p: timespan, t: datetime) [5m, datetime(2026-01-01 00:07)] | summarize n = count() by b = bin(t, p)',
      'datatable(p: timespan) [5m] | extend b = floor(now(), p)',
      'T | extend lastDue = anchor + period * tolong((Now - Grace - anchor) / period)',
    ]) {
      expect(nonConstantArguments(query), query).toEqual([]);
    }
  });

  it('reads past nested calls, strings, comments and interpolations, and only the function named', () => {
    expect(nonConstantArguments("print b = bin_at(now(), 1d, todatetime('2026-01-01, period'))")).toEqual([]);
    expect(nonConstantArguments('// bin_at(t, period, anchor) is refused\nprint 1')).toEqual([]);
    expect(nonConstantArguments('print b = bin_at(now(), ${var.period}, datetime(2026-01-01))')).toEqual([]);
    expect(nonConstantArguments('T | extend b = my_bin_at(t, period, anchor)')).toEqual([]);
    expect(nonConstantArguments('T | extend b = bin_at(t, iff(x > 0, 1h, 2h), datetime(2026-01-01))')).toEqual([
      'bin_at() argument 2 (bin size) is `iff(x > 0, 1h, 2h)`, which reads x: not a literal, not a let of this query',
    ]);
  });

  it('never checks a function measured to accept a column', () => {
    for (const fn of Object.keys(MEASURED_COLUMN_ACCEPTED)) {
      expect(Object.hasOwn(MEASURED_CONSTANT_ARGUMENTS, fn), fn).toBe(false);
    }
  });
});

describe('the measured reserved list', () => {
  it('is disjoint from the names measured to work', () => {
    // One word in both sets means a transcription slip, and a guard built on
    // a slip is worse than none.
    for (const name of MEASURED_RESERVED) expect(MEASURED_ACCEPTABLE.has(name)).toBe(false);
  });

  it('carries the name that caused the partial apply', () => {
    expect(MEASURED_RESERVED.has('missing')).toBe(true);
  });
});
