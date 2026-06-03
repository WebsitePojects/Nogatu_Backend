const { pool } = require('../config/database');

function normalizeRequirementSet(requirements = {}) {
  return {
    tables: Array.isArray(requirements.tables) ? requirements.tables : [],
    columns: requirements.columns && typeof requirements.columns === 'object'
      ? requirements.columns
      : {},
  };
}

async function getSchemaSnapshot(conn = pool) {
  const [[tableRows], [columnRows]] = await Promise.all([
    conn.query(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE()`
    ),
    conn.query(
      `SELECT TABLE_NAME AS table_name,
              COLUMN_NAME AS column_name,
              COLUMN_TYPE AS column_type
         FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()`
    ),
  ]);

  const tables = new Set(tableRows.map((row) => row.table_name));
  const columns = new Map();

  for (const row of columnRows) {
    if (!columns.has(row.table_name)) {
      columns.set(row.table_name, new Map());
    }
    columns.get(row.table_name).set(row.column_name, {
      columnType: String(row.column_type || '').toLowerCase(),
    });
  }

  return { tables, columns };
}

function listMissingSchemaRequirements(snapshot, requirements = {}) {
  const normalized = normalizeRequirementSet(requirements);
  const missing = [];

  for (const tableName of normalized.tables) {
    if (!snapshot.tables.has(tableName)) {
      missing.push({ type: 'table', table: tableName });
    }
  }

  for (const [tableName, columnRequirements] of Object.entries(normalized.columns)) {
    const tableColumns = snapshot.columns.get(tableName);
    if (!tableColumns) {
      missing.push({ type: 'table', table: tableName });
      continue;
    }

    for (const [columnName, checks] of Object.entries(columnRequirements || {})) {
      const column = tableColumns.get(columnName);
      if (!column) {
        missing.push({ type: 'column', table: tableName, column: columnName });
        continue;
      }

      const typeIncludes = String(checks?.typeIncludes || '').trim().toLowerCase();
      if (typeIncludes && !column.columnType.includes(typeIncludes)) {
        missing.push({
          type: 'column_type',
          table: tableName,
          column: columnName,
          expected: typeIncludes,
          actual: column.columnType,
        });
      }
    }
  }

  return missing;
}

function createSchemaNotReadyError(featureLabel, missing = []) {
  const error = new Error(`${featureLabel} is not ready. Please run database migrations.`);
  error.code = 'SCHEMA_NOT_READY';
  error.status = 503;
  error.details = { featureLabel, missing };
  return error;
}

async function assertSchemaRequirements(requirements, featureLabel, conn = pool) {
  const snapshot = await getSchemaSnapshot(conn);
  const missing = listMissingSchemaRequirements(snapshot, requirements);
  if (missing.length > 0) {
    throw createSchemaNotReadyError(featureLabel, missing);
  }
  return snapshot;
}

function mergeRequirements(...sets) {
  return sets.reduce((merged, current) => {
    const normalized = normalizeRequirementSet(current);
    for (const tableName of normalized.tables) {
      if (!merged.tables.includes(tableName)) merged.tables.push(tableName);
    }
    for (const [tableName, columns] of Object.entries(normalized.columns)) {
      merged.columns[tableName] = {
        ...(merged.columns[tableName] || {}),
        ...(columns || {}),
      };
    }
    return merged;
  }, { tables: [], columns: {} });
}

const SCHEMA_REQUIREMENTS = {
  AUTH_PASSWORDS: {
    tables: ['memberstab', 'accesstab'],
    columns: {
      memberstab: {
        password: { typeIncludes: 'varchar(255)' },
      },
      accesstab: {
        password: { typeIncludes: 'varchar(255)' },
      },
    },
  },
  MEMBER_PROFILE: {
    tables: ['memberstab'],
    columns: {
      memberstab: {
        tin: { typeIncludes: 'varchar(30)' },
        email: { typeIncludes: 'varchar(180)' },
        contactnos: { typeIncludes: 'varchar(30)' },
        address: { typeIncludes: 'varchar(255)' },
        dob: { typeIncludes: 'varchar(30)' },
      },
    },
  },
  PUBLIC_REGISTRATION: {
    tables: ['referral_invitestab', 'public_registration_audittab', 'usertab'],
    columns: {
      usertab: {
        public_uid: { typeIncludes: 'char(36)' },
        referral_slug: { typeIncludes: 'varchar(32)' },
      },
      public_registration_audittab: {
        requested_position: {},
        enforced_position: {},
        placement_policy_mode: { typeIncludes: 'varchar(32)' },
        placement_policy_reason: { typeIncludes: 'varchar(120)' },
        consumed_at: {},
      },
    },
  },
  CONTACT: {
    tables: ['contact_messagestab', 'contact_blockedtab'],
  },
  NEWS: {
    tables: ['newstab'],
  },
  APPLICATIONS: {
    tables: ['distributor_applicationstab'],
    columns: {
      distributor_applicationstab: {
        age: {},
        letter_of_intent_url: { typeIncludes: 'varchar(500)' },
        letter_of_intent_public_id: { typeIncludes: 'varchar(255)' },
        letter_of_intent_filename: { typeIncludes: 'varchar(255)' },
        letter_of_intent_uploaded_at: {},
        follow_up_status: {},
      },
    },
  },
  VOUCHERS: {
    tables: ['voucherstab', 'voucher_transactionstab'],
    columns: {
      voucherstab: {
        suspend_reason: { typeIncludes: 'varchar(500)' },
        suspended_by: { typeIncludes: 'varchar(120)' },
        suspended_at: {},
        first_used_at: {},
        use_expires_at: {},
        revoked_at: {},
        revocation_reason: { typeIncludes: 'varchar(500)' },
      },
    },
  },
  FINANCE: {
    tables: [
      'finance_package_coststab',
      'finance_budget_columntab',
      'finance_budget_column_valuestab',
    ],
  },
  GLOBAL_BONUS: {
    tables: ['globalbonus_poolstab', 'globalbonus_membertab'],
    columns: {
      globalbonus_poolstab: {
        period_scope: { typeIncludes: 'varchar(16)' },
        period_month: {},
      },
      globalbonus_membertab: {
        period_scope: { typeIncludes: 'varchar(16)' },
        period_month: {},
      },
    },
  },
  RANKING: {
    tables: ['rankingstab', 'rank_sequence_countertab'],
    columns: {
      rankingstab: {
        highest_rank_no: {},
        basis_points: {},
        consumed_points: {},
        remaining_rankable_points: {},
        basis_label: { typeIncludes: 'varchar(120)' },
        race_basis_mode: { typeIncludes: 'varchar(40)' },
        race_last_awarded_at: {},
        pending_achievement_count: {},
        last_calculated_at: {},
      },
    },
  },
  PASSWORD_RESET: {
    tables: ['password_reset_tokenstab'],
  },
  SUPPORT: {
    tables: ['support_ticketstab'],
  },
  HIFIVE: {
    tables: ['hifive_qualificationstab'],
  },
};

SCHEMA_REQUIREMENTS.READINESS = mergeRequirements(
  SCHEMA_REQUIREMENTS.AUTH_PASSWORDS,
  SCHEMA_REQUIREMENTS.MEMBER_PROFILE,
  SCHEMA_REQUIREMENTS.PUBLIC_REGISTRATION,
  SCHEMA_REQUIREMENTS.CONTACT,
  SCHEMA_REQUIREMENTS.NEWS,
  SCHEMA_REQUIREMENTS.APPLICATIONS,
  SCHEMA_REQUIREMENTS.VOUCHERS,
  SCHEMA_REQUIREMENTS.FINANCE,
  SCHEMA_REQUIREMENTS.GLOBAL_BONUS,
  SCHEMA_REQUIREMENTS.RANKING,
  SCHEMA_REQUIREMENTS.PASSWORD_RESET,
  SCHEMA_REQUIREMENTS.SUPPORT,
  SCHEMA_REQUIREMENTS.HIFIVE,
  {
    tables: [
      'usertab',
      'memberstab',
      'payouttotaltab',
      'payouthistorytab',
      'binary_tree_closuretab',
      'binary_point_eventstab',
      'income_eventstab',
      'encashmentstab',
      'rank_definitionstab',
      'rank_point_consumptiontab',
      'audit_logtab',
    ],
  }
);

module.exports = {
  SCHEMA_REQUIREMENTS,
  assertSchemaRequirements,
  createSchemaNotReadyError,
  getSchemaSnapshot,
  listMissingSchemaRequirements,
  mergeRequirements,
};
