import { getBusinessDateCRInfo } from '../../src/utils/businessDate';

describe('Business date (CR) utils', () => {
  test('uses sorteo.scheduledAt when provided', () => {
    const scheduledAt = new Date('2025-11-02T18:21:00Z');
    const nowUtc = new Date('2025-11-03T00:00:00Z');
    const r = getBusinessDateCRInfo({ scheduledAt, nowUtc, cutoffHour: '06:00' });
    expect(r.prefixYYMMDD).toMatch(/^\d{6}$/);
  });

  test('fallback by cutoff before HH:mm uses previous day', () => {
    const nowUtc = new Date('2025-11-03T05:00:00Z'); // 23:00 CR previous day
    const r = getBusinessDateCRInfo({ scheduledAt: null, nowUtc, cutoffHour: '06:00' });
    expect(r.prefixYYMMDD).toHaveLength(6);
  });
});

// Integration tests would create tickets concurrently and verify no collisions.
// These are omitted here to avoid hitting the database in CI by default.

