import { describe, expect, it } from 'vitest';
import { DATA_EXPLORER_MODELS } from '../../src/platform/data-explorer-metadata.js';
import { PII_FIELDS, SECRET_FIELDS } from '../../src/platform/privacy-policy.js';

const FORBIDDEN_MODELS = [
  'Session',
  'EmployeeSession',
  'PlatformAuditEvent',
  'ContactInvite',
  'WaslSignWebhookEvent',
  'MaintenanceRequestAttachment',
];

describe('Data Explorer model metadata — security invariants', () => {
  it('never allowlists a model that must stay hidden from the explorer entirely', () => {
    for (const forbidden of FORBIDDEN_MODELS) {
      expect(DATA_EXPLORER_MODELS).not.toHaveProperty(forbidden);
    }
  });

  it('never lists a field classified SECRET on any allowlisted model', () => {
    for (const [modelName, meta] of Object.entries(DATA_EXPLORER_MODELS)) {
      const secretFields = SECRET_FIELDS[modelName] ?? [];
      const listedFieldNames = meta.fields.map((f) => f.name);
      for (const secret of secretFields) {
        expect(listedFieldNames).not.toContain(secret);
      }
    }
  });

  it('flags every field classified PII in the central registry as piiSensitive here too', () => {
    for (const [modelName, piiFields] of Object.entries(PII_FIELDS)) {
      const meta = DATA_EXPLORER_MODELS[modelName];
      if (!meta) continue; // model not exposed in the explorer at all — fine
      for (const piiField of piiFields) {
        const field = meta.fields.find((f) => f.name === piiField);
        if (!field) continue; // field not exposed — fine, strictly more restrictive
        expect(field.piiSensitive, `${modelName}.${piiField} should be piiSensitive`).toBe(true);
      }
    }
  });

  it('every relation targets another allowlisted model, so Linked Relations never points somewhere the explorer itself forbids', () => {
    for (const meta of Object.values(DATA_EXPLORER_MODELS)) {
      for (const relation of meta.relations) {
        expect(DATA_EXPLORER_MODELS).toHaveProperty(relation.targetModel);
      }
    }
  });

  it('json-typed fields are never marked editable (no raw JSON editor exists)', () => {
    for (const meta of Object.values(DATA_EXPLORER_MODELS)) {
      for (const field of meta.fields) {
        if (field.type === 'json') {
          expect(
            field.editable,
            `${meta.model}.${field.name} is json and must not be editable`,
          ).toBe(false);
        }
      }
    }
  });

  it('Employee is visible, every field view-only, row deletion allowed (Super-Admin-only), passwordHash never listed', () => {
    const meta = DATA_EXPLORER_MODELS.Employee;
    expect(meta).toBeTruthy();
    expect(meta.deletable).toBe(true);
    for (const field of meta.fields) {
      expect(field.editable, `Employee.${field.name} must not be editable`).toBe(false);
    }
    expect(meta.fields.map((f) => f.name)).not.toContain('passwordHash');
  });

  it('an enum field always carries at least one enumValues entry', () => {
    for (const meta of Object.values(DATA_EXPLORER_MODELS)) {
      for (const field of meta.fields) {
        if (field.type === 'enum') {
          expect(field.enumValues?.length ?? 0, `${meta.model}.${field.name}`).toBeGreaterThan(0);
        }
      }
    }
  });
});
