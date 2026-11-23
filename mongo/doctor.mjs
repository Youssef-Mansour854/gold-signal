import { withMongo } from "./config.mjs";

/** Read-only deployment capability check. Never downgrades silently. */
export async function checkCapabilities(db, client) {
  const hello = await client.db("admin").command({ hello: 1 });
  const buildInfo = await client.db("admin").command({ buildInfo: 1 });
  const version = String(buildInfo.version ?? "0");
  const major = Number(version.split(".")[0] ?? 0);
  const isReplicaSet = Boolean(hello.setName);
  const versionString = `${version} ${buildInfo.versionArray ?? ""}`.toLowerCase();
  const isDocumentDb = versionString.includes("documentdb")
    || JSON.stringify(hello).toLowerCase().includes("docdb");

  const checks = [
    { name: "replica_set", pass: isReplicaSet, detail: isReplicaSet ? `set=${hello.setName}` : "no setName in hello" },
    { name: "transactions", pass: isReplicaSet, detail: "multi-document transactions need a replica set" },
    { name: "mongodb_6_plus", pass: major >= 6, detail: `version=${version}` },
    { name: "json_schema_validators", pass: major >= 6 && !isDocumentDb, detail: isDocumentDb ? "DocumentDB support must be verified" : "native" },
    { name: "create_role", pass: !isDocumentDb, detail: isDocumentDb ? "managed DocumentDB may restrict role management" : "native" },
    { name: "views", pass: major >= 6 && !isDocumentDb, detail: isDocumentDb ? "managed DocumentDB view support varies" : "native" },
    { name: "compound_unique_indexes", pass: true, detail: "regular collections only; no time-series collections" },
    { name: "decimal128", pass: true, detail: "BSON decimal supported by driver" },
  ];
  const gaps = checks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.detail}`);
  return { ok: gaps.length === 0, isDocumentDb, version, checks, gaps };
}

export async function doctorMain() {
  const report = await withMongo({}, async (db, client) => {
    const base = await checkCapabilities(db, client);
    const roleGap = await db.collection("deployment_gaps")
      .findOne({ kind: "custom_roles_unavailable" })
      .catch(() => null);
    if (!roleGap) return base;
    const roles = (roleGap.roles ?? []).map((gap) => gap.role).join(", ");
    const detail = `custom roles not enforced (${roles || "unknown"}); the MongoDB write layer must stay disabled`;
    return {
      ...base,
      ok: false,
      checks: [...base.checks, { name: "custom_roles", pass: false, detail }],
      gaps: [...base.gaps, `custom_roles: ${detail}`],
    };
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(`Capability gaps detected: ${report.gaps.join("; ")}`);
    process.exitCode = 2;
  }
  return report;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/doctor.mjs")) {
  doctorMain().catch((error) => {
    console.error("Doctor failed:", error.message);
    process.exitCode = 1;
  });
}
