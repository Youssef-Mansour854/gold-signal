import {
  ALL_COLLECTIONS,
  APP_WRITER_COLLECTIONS,
  EVALUATOR_WRITER_COLLECTIONS,
} from "../schema/validators.mjs";

export const description = "Create app_writer, evaluator_writer, reader and admin roles.";

const ROLES = ["app_writer", "evaluator_writer", "reader", "data_admin"];
const GAP_COLLECTION = "deployment_gaps";
const GAP_KIND = "custom_roles_unavailable";

function ns(dbName, collection) {
  return { db: dbName, collection };
}

function privileges(dbName, collections, ...verbs) {
  return collections.map((collection) => ({
    resource: ns(dbName, collection),
    actions: verbs,
  }));
}

// Managed Atlas tiers can reject role commands even for a project owner.
function isRoleManagementDenied(error) {
  return /CMD_NOT_ALLOWED|Unauthorized|not authorized/i.test(error?.message ?? "");
}

function roleCommandError(role, command, error) {
  return new Error(`Cannot ${command} role ${role}: ${error.message}`, { cause: error });
}

function definitions(dbName) {
  return {
    app_writer: {
      privileges: [
        ...privileges(dbName, APP_WRITER_COLLECTIONS, "find", "insert"),
        { resource: ns(dbName, "ledger_seq"), actions: ["find", "insert", "update"] },
      ],
      roles: [],
    },
    evaluator_writer: {
      privileges: [
        ...privileges(dbName, EVALUATOR_WRITER_COLLECTIONS, "find", "insert"),
        ...privileges(dbName, ALL_COLLECTIONS.filter(
          (collection) => !EVALUATOR_WRITER_COLLECTIONS.includes(collection),
        ), "find"),
        { resource: ns(dbName, "ledger_seq"), actions: ["find", "insert", "update"] },
      ],
      roles: [],
    },
    reader: {
      privileges: [{ resource: ns(dbName, ""), actions: ["find"] }],
      roles: [],
    },
    data_admin: {
      privileges: [],
      roles: [{ role: "dbOwner", db: dbName }],
    },
  };
}

export async function up(db) {
  const dbName = db.databaseName;
  const info = await db.command({ rolesInfo: 1, showBuiltinRoles: false });
  const existing = new Set(info.roles
    .filter((role) => role.db === dbName)
    .map((role) => role.role));
  const specs = definitions(dbName);
  const gaps = [];

  for (const role of ROLES) {
    const command = existing.has(role) ? "updateRole" : "createRole";
    try {
      await db.command({ [command]: role, ...specs[role] });
    } catch (error) {
      if (!isRoleManagementDenied(error)) throw roleCommandError(role, command, error);
      gaps.push({ role, command, detail: error.message });
    }
  }

  if (gaps.length > 0) {
    await db.collection(GAP_COLLECTION).updateOne(
      { kind: GAP_KIND },
      {
        $set: {
          kind: GAP_KIND,
          roles: gaps,
          detected_at: new Date(),
          note: "Role management is forbidden on this deployment tier. Do not enable the MongoDB write layer until custom roles are enforced.",
        },
      },
      { upsert: true },
    );
    console.warn(`role management unavailable; recorded ${GAP_KIND} for: ${gaps.map((gap) => gap.role).join(", ")}`);
  } else {
    await db.collection(GAP_COLLECTION).deleteMany({ kind: GAP_KIND });
  }
}

export async function down(db) {
  for (const role of ROLES) {
    try {
      await db.command({ dropRole: role });
    } catch (error) {
      // MongoDB 9 says "Could not find role: name@db" instead of "RoleNotFound".
      if (error?.code === 316 || /RoleNotFound|Could not find role/i.test(error?.message ?? "")) continue;
      if (isRoleManagementDenied(error)) continue;
      throw roleCommandError(role, "dropRole", error);
    }
  }
  await db.collection(GAP_COLLECTION).deleteMany({ kind: GAP_KIND });
}
