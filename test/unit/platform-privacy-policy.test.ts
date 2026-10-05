import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import {
  canViewUnmaskedPii,
  canViewUnmaskedPiiInSql,
  maskPiiFields,
  resolveGeneralPiiMode,
} from '../../src/platform/privacy-policy.js';

describe('platform privacy policy', () => {
  const original = {
    NODE_ENV: env.NODE_ENV,
    BACKOFFICE_PII_MODE: env.BACKOFFICE_PII_MODE,
    BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED: env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED,
  };

  beforeEach(() => {
    env.NODE_ENV = original.NODE_ENV;
    env.BACKOFFICE_PII_MODE = original.BACKOFFICE_PII_MODE;
    env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = original.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED;
  });

  afterEach(() => {
    env.NODE_ENV = original.NODE_ENV;
    env.BACKOFFICE_PII_MODE = original.BACKOFFICE_PII_MODE;
    env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = original.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED;
  });

  describe('resolveGeneralPiiMode', () => {
    it('defaults to masked in production when BACKOFFICE_PII_MODE is unset', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = undefined;
      expect(resolveGeneralPiiMode()).toBe('masked');
    });

    it('stays masked in production even if BACKOFFICE_PII_MODE is some unexpected value', () => {
      env.NODE_ENV = 'production';
      // @ts-expect-error deliberately simulating an invalid/ambiguous config value
      env.BACKOFFICE_PII_MODE = 'yes-please';
      expect(resolveGeneralPiiMode()).toBe('masked');
    });

    it('only unmasks production when BACKOFFICE_PII_MODE is explicitly "full"', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = 'full';
      expect(resolveGeneralPiiMode()).toBe('full');
    });

    it('defaults to full in development when unset', () => {
      env.NODE_ENV = 'development';
      env.BACKOFFICE_PII_MODE = undefined;
      expect(resolveGeneralPiiMode()).toBe('full');
    });

    it('can still be explicitly masked in a lower environment', () => {
      env.NODE_ENV = 'development';
      env.BACKOFFICE_PII_MODE = 'masked';
      expect(resolveGeneralPiiMode()).toBe('masked');
    });
  });

  describe('canViewUnmaskedPii', () => {
    it('requires both the pii.view capability and the environment policy', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = 'full';
      expect(canViewUnmaskedPii(['pii.view'])).toBe(true);
      expect(canViewUnmaskedPii([])).toBe(false);

      env.BACKOFFICE_PII_MODE = undefined;
      expect(canViewUnmaskedPii(['pii.view'])).toBe(false);
    });
  });

  describe('canViewUnmaskedPiiInSql — independent of the general PII gate', () => {
    it('requires the SQL-specific capability and the SQL-specific config switch, not the general ones', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = 'full'; // general mode unmasked...
      env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = false; // ...but SQL switch is off
      expect(canViewUnmaskedPiiInSql(['database.sql.pii.unmasked'])).toBe(false);

      env.BACKOFFICE_PII_MODE = 'masked'; // general mode masked...
      env.BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED = true; // ...but SQL switch is on
      expect(canViewUnmaskedPiiInSql(['database.sql.pii.unmasked'])).toBe(true);

      expect(canViewUnmaskedPiiInSql([])).toBe(false);
    });
  });

  describe('maskPiiFields', () => {
    it('masks User.email but leaves non-PII fields untouched', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = undefined;
      const record = { id: 'user_1', email: 'sophie.walker@example.com', firstName: 'Sophie' };
      const masked = maskPiiFields('User', record, []);
      expect(masked.email).toBe('s***@example.com');
      expect(masked.firstName).toBe('Sophie');
      expect(masked.id).toBe('user_1');
    });

    it('masks PropertyContact.email and .phone', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = undefined;
      const record = { email: 'james.nguyen@example.com', phone: '+61491234567' };
      const masked = maskPiiFields('PropertyContact', record, []);
      expect(masked.email).toBe('j***@example.com');
      expect(masked.phone).not.toBe(record.phone);
      expect(masked.phone).toMatch(/\*{3}/);
    });

    it('masks Contractor.email and .phone, following the same central classification as other contact records', () => {
      env.NODE_ENV = 'production';
      env.BACKOFFICE_PII_MODE = undefined;
      const record = {
        email: 'ops@acmeplumbing.example',
        phone: '+61491234567',
        name: 'Acme Plumbing',
      };
      const masked = maskPiiFields('Contractor', record, []);
      expect(masked.email).toBe('o***@acmeplumbing.example');
      expect(masked.phone).not.toBe(record.phone);
      expect(masked.phone).toMatch(/\*{3}/);
      expect(masked.name).toBe('Acme Plumbing');
    });

    it('returns the record unmasked when the actor holds pii.view and policy allows it', () => {
      env.NODE_ENV = 'development';
      env.BACKOFFICE_PII_MODE = undefined; // defaults to full in dev
      const record = { email: 'sophie.walker@example.com' };
      const result = maskPiiFields('User', record, ['pii.view']);
      expect(result.email).toBe('sophie.walker@example.com');
    });

    it('is a no-op for a model with no classified PII fields', () => {
      const record = { id: 'prop_1', name: 'Bondi Beach Residences' };
      const masked = maskPiiFields('Property', record, []);
      expect(masked).toEqual(record);
    });
  });
});
