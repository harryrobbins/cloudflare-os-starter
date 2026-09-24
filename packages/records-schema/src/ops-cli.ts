// Operator commands for Records operations (canonical plan §8, Phase 6), dispatched from cli.ts.
// Every command prints what it would do and changes nothing unless --apply is given. Runbook:
// docs/plans/external_datastores/records-operations.md.
//
// The operations themselves live in @records/core (packages/records-core/src/ops), which is written
// for bundlers: its relative imports name `.js` files that exist as `.ts`. @records/schema does not
// depend on @records/core (the dependency runs the other way), so this loads the ops module by path
// and teaches Node's resolver that one mapping first.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";

import postgres, { type Sql } from "postgres";

let hooked = false;
async function loadOps() {
  if (!hooked) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (err) {
          if (/^\.\.?\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
          throw err;
        }
      },
    });
    hooked = true;
  }
  return import("../../records-core/src/ops/index.ts");
}

function need(values: Record<string, unknown>, ...names: string[]): void {
  const missing = names.filter((n) => values[n] === undefined || values[n] === "");
  if (missing.length) throw new Error(`Missing ${missing.map((n) => `--${n}`).join(", ")}.`);
}

function show(title: string, value: unknown): void {
  console.log(`${title}\n${JSON.stringify(value, null, 2)}`);
}

const DRY = "\nDry run: nothing was changed. Re-run with --apply to do it.";

export const OPS_COMMANDS = ["restore-datastore", "redact", "archive-journal", "analytics-grant"] as const;

export const OPS_USAGE = `
  restore-datastore --datastore <uuid> --actor <principal uuid> (--upto-seq <n> | --upto-time <ISO time>) [--reason <text>] [--apply]
      source: RECORDS_RESTORE_SOURCE_URL (owner URL of the restored Neon branch); target: RECORDS_MIGRATION_URL
  redact --datastore <uuid> --entity-type <project|issue|comment> --entity-id <uuid> --fields <a,b> --reason <text> --actor <principal uuid> [--marker <text>] [--apply]
  archive-journal --older-than-months <n> --out-dir <dir> [--drop] [--apply]
  analytics-grant --login <name> --principal <uuid> [--connection-limit <n>] [--apply]
      password: RECORDS_ANALYTICS_PASSWORD, or generated and printed once`;

export async function runOpsCommand(command: (typeof OPS_COMMANDS)[number], sql: Sql, argv: string[]): Promise<void> {
  const ops = await loadOps();
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: "boolean", default: false },
      datastore: { type: "string" },
      actor: { type: "string" },
      "upto-seq": { type: "string" },
      "upto-time": { type: "string" },
      reason: { type: "string" },
      "entity-type": { type: "string" },
      "entity-id": { type: "string" },
      fields: { type: "string" },
      marker: { type: "string" },
      "older-than-months": { type: "string" },
      "out-dir": { type: "string" },
      drop: { type: "boolean", default: false },
      login: { type: "string" },
      principal: { type: "string" },
      "connection-limit": { type: "string" },
    },
    strict: true,
  });
  const apply = values.apply === true;

  if (command === "restore-datastore") {
    need(values, "datastore", "actor");
    if ((values["upto-seq"] === undefined) === (values["upto-time"] === undefined)) throw new Error("Give exactly one of --upto-seq and --upto-time.");
    const sourceUrl = process.env.RECORDS_RESTORE_SOURCE_URL;
    if (!sourceUrl) throw new Error("Set RECORDS_RESTORE_SOURCE_URL to the restored branch's owner connection string.");
    if (sourceUrl === process.env.RECORDS_MIGRATION_URL) console.log("Note: the source is the target itself (replaying its own journal).");
    const source = postgres(sourceUrl, { max: 1, onnotice: () => {} });
    try {
      const report = await ops.restoreDatastore({
        source, target: sql, datastoreId: values.datastore!, actorId: values.actor!,
        ...(values["upto-seq"] !== undefined ? { uptoSeq: Number(values["upto-seq"]) } : { uptoTime: values["upto-time"]! }),
        ...(values.reason ? { reason: values.reason } : {}),
        dryRun: !apply,
      });
      show(apply ? "Restore applied:" : "Restore plan:", report);
      console.log(`\n${report.changes.length} change(s), ${report.cannotRemove.length} entit(ies) that cannot be removed, ${report.unresolved.length} unresolved.`);
      if (!apply) console.log(DRY);
    } finally {
      await source.end();
    }
    return;
  }

  if (command === "redact") {
    need(values, "datastore", "entity-type", "entity-id", "fields", "reason", "actor");
    const input = {
      datastoreId: values.datastore!, entityType: values["entity-type"] as "project" | "issue" | "comment", entityId: values["entity-id"]!,
      fields: values.fields!.split(",").map((f) => f.trim()).filter(Boolean), reason: values.reason!, actorId: values.actor!,
      ...(values.marker ? { marker: values.marker } : {}),
    };
    const preview = await ops.previewRedaction(sql, input);
    if (!preview.exists) throw new Error(`No ${input.entityType} ${input.entityId} in datastore ${input.datastoreId}.`);
    show("Redaction preview (lengths only; the text is never printed):", preview);
    if (!apply) {
      console.log(DRY);
      return;
    }
    show("Redacted:", await ops.redact(sql, input));
    console.log("\nBackups and Neon history still hold the old text until they age out; see the runbook.");
    return;
  }

  if (command === "archive-journal") {
    need(values, "older-than-months", "out-dir");
    const outDir = resolve(values["out-dir"]!);
    const result = await ops.archiveJournalPartitions({
      db: sql, olderThanMonths: Number(values["older-than-months"]), dryRun: !apply, dropDetached: values.drop === true,
      exportTo: async (name, lines) => {
        mkdirSync(outDir, { recursive: true, mode: 0o700 });
        const file = join(outDir, `${name}.gz`);
        const partial = `${file}.partial`;
        await pipeline(Readable.from(lines), createGzip({ level: 9 }), createWriteStream(partial, { mode: 0o600, flags: "wx" }));
        const hash = createHash("sha256");
        await pipeline(createReadStream(partial), hash);
        renameSync(partial, file);
        return { location: file, sha256: hash.digest("hex") };
      },
    });
    show(apply ? "Journal archival:" : "Journal archival plan:", result);
    if (result.defaultRowsBeforeCutoff > 0) console.log(`\nWarning: ${result.defaultRowsBeforeCutoff} rows older than the cutoff sit in journal_default; they are not archived.`);
    const done = result.partitions.filter((p) => p.status === "archived");
    if (done.length) {
      console.log("\nUpload each file, verify it, and only then drop any partition kept detached (see the runbook):");
      for (const p of done) console.log(`  pnpm exec wrangler r2 object put <bucket>/records/journal/${p.name}.ndjson.gz --file ${p.location!} --remote`);
    }
    if (!apply) console.log(DRY);
    return;
  }

  // analytics-grant
  need(values, "login", "principal");
  const generated = !process.env.RECORDS_ANALYTICS_PASSWORD;
  const password = process.env.RECORDS_ANALYTICS_PASSWORD ?? randomBytes(24).toString("base64url");
  const plan = await ops.grantAnalyticsLogin(sql, {
    login: values.login!, principalId: values.principal!, password, dryRun: !apply,
    ...(values["connection-limit"] ? { connectionLimit: Number(values["connection-limit"]) } : {}),
  });
  show(apply ? "Analytics login created:" : "Analytics login plan:", plan);
  if (!apply) {
    console.log(DRY);
    return;
  }
  if (generated) console.log(`\nPassword (shown once; store it now): ${password}`);
  console.log(`Views: ${ops.ANALYTICS_VIEWS_V1.map((v) => `analytics.${v}`).join(", ")}`);
}
