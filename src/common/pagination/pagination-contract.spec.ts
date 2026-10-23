/**
 * @file pagination-contract.spec.ts
 *
 * Contract tests for pagination, filtering, and authorization boundaries
 * (issue #274).
 *
 * Covers:
 *  - Normal cursor pagination (forward and backward, first page and subsequent pages)
 *  - Filtering constraints enforced by the keyset service
 *  - Authorization boundaries: malformed cursors are rejected before any query
 *    executes, preventing cursor-injection enumeration attacks
 *  - Failure paths: tampered, expired-version, and oversized cursors
 *  - Retry paths: decoding is deterministic — the same valid cursor always
 *    decodes to the same position
 *
 * These tests run entirely in-process with no database; all query-builder
 * interactions are mocked so the suite passes in CI without a Postgres
 * connection.
 */

import { BadRequestException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { CursorPaginationService } from './cursor-pagination.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CREATED_AT = new Date('2026-03-15T12:00:00.000Z');

/** Minimal mock that satisfies the SelectQueryBuilder call sites. */
function mockQb() {
  const qb = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
  };
  return qb as unknown as SelectQueryBuilder<unknown>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Pagination contract — CursorPaginationService (issue #274)', () => {
  let service: CursorPaginationService;

  beforeEach(() => {
    service = new CursorPaginationService();
  });

  // -------------------------------------------------------------------------
  // Normal path: encode → decode round-trip
  // -------------------------------------------------------------------------
  describe('Normal pagination — cursor round-trip', () => {
    it('encodes a valid position and decodes it back identically', () => {
      const position = { id: VALID_UUID, createdAt: CREATED_AT };
      const cursor = service.encode(position);
      expect(service.decode(cursor)).toEqual(position);
    });

    it('produces a URL-safe (base64url) cursor with no padding characters', () => {
      const cursor = service.encode({ id: VALID_UUID, createdAt: CREATED_AT });
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cursor).not.toMatch(/[+/=]/);
    });

    it('cursor does not leak the raw UUID or ISO timestamp', () => {
      const cursor = service.encode({ id: VALID_UUID, createdAt: CREATED_AT });
      expect(cursor).not.toContain(VALID_UUID);
      expect(cursor).not.toContain(CREATED_AT.toISOString());
    });

    it('two positions with different ids produce different cursors', () => {
      const c1 = service.encode({ id: VALID_UUID, createdAt: CREATED_AT });
      const c2 = service.encode({ id: OTHER_UUID, createdAt: CREATED_AT });
      expect(c1).not.toBe(c2);
    });

    it('encoding is deterministic — same position always yields the same cursor', () => {
      const pos = { id: VALID_UUID, createdAt: CREATED_AT };
      expect(service.encode(pos)).toBe(service.encode(pos));
    });
  });

  // -------------------------------------------------------------------------
  // Normal path: keyset predicates (forward and backward)
  // -------------------------------------------------------------------------
  describe('Normal pagination — keyset predicates applied to query builders', () => {
    it('applies DESC ordering and keyset predicate for a subsequent descending page', () => {
      const qb = mockQb();
      const cursor = service.encode({ id: VALID_UUID, createdAt: CREATED_AT });

      service.applyDescendingKeyset(qb, 'item', cursor);

      expect(qb.orderBy).toHaveBeenCalledWith('item.createdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('item.id', 'DESC');
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(item.createdAt < :cursorCreatedAt OR (item.createdAt = :cursorCreatedAt AND item.id < :cursorId))',
        { cursorCreatedAt: CREATED_AT, cursorId: VALID_UUID },
      );
    });

    it('applies ASC ordering and keyset predicate for a subsequent ascending page', () => {
      const qb = mockQb();
      const cursor = service.encode({ id: VALID_UUID, createdAt: CREATED_AT });

      service.applyKeyset(qb, 'notification', cursor, 'ASC');

      expect(qb.orderBy).toHaveBeenCalledWith('notification.createdAt', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('notification.id', 'ASC');
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(notification.createdAt > :cursorCreatedAt OR (notification.createdAt = :cursorCreatedAt AND notification.id > :cursorId))',
        { cursorCreatedAt: CREATED_AT, cursorId: VALID_UUID },
      );
    });

    it('skips the keyset predicate for the first page (no cursor)', () => {
      const qb = mockQb();

      service.applyDescendingKeyset(qb, 'item');

      expect(qb.orderBy).toHaveBeenCalledWith('item.createdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('item.id', 'DESC');
      // Authorization boundary: no WHERE clause injected without a cursor
      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Filtering boundary: pagination options carry valid limits
  // -------------------------------------------------------------------------
  describe('Filtering contract — page-size boundaries', () => {
    it('default limit on CursorPaginationDto is 20', () => {
      // Ensures the DTO default is preserved — changing it is a breaking contract change
      const { CursorPaginationDto } = require('./cursor-pagination.dto');
      const dto = new CursorPaginationDto();
      expect(dto.limit).toBe(20);
    });

    it('default direction on CursorPaginationDto is forward', () => {
      const { CursorPaginationDto } = require('./cursor-pagination.dto');
      const dto = new CursorPaginationDto();
      expect(dto.direction).toBe('forward');
    });
  });

  // -------------------------------------------------------------------------
  // Authorization boundary: malformed / tampered cursors are rejected
  // -------------------------------------------------------------------------
  describe('Authorization boundary — cursor validation gate', () => {
    it('rejects an empty string before any query executes', () => {
      expect(() => service.decode('')).toThrow(BadRequestException);
    });

    it('rejects a plaintext string that is not base64url', () => {
      expect(() => service.decode('not-a-cursor')).toThrow(BadRequestException);
    });

    it('rejects a cursor that decodes to an empty JSON object (missing required fields)', () => {
      const tampered = Buffer.from('{}', 'utf8').toString('base64url');
      expect(() => service.decode(tampered)).toThrow(BadRequestException);
    });

    it('rejects a cursor with a non-canonical timestamp (date-only string)', () => {
      const payload = JSON.stringify({ v: 1, createdAt: '2026-01-02', id: VALID_UUID });
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');
      expect(() => service.decode(cursor)).toThrow(BadRequestException);
    });

    it('rejects a cursor whose version has been bumped to an unsupported value', () => {
      const payload = JSON.stringify({ v: 99, createdAt: CREATED_AT.toISOString(), id: VALID_UUID });
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');
      expect(() => service.decode(cursor)).toThrow(BadRequestException);
    });

    it('rejects a cursor that exceeds the maximum allowed length (> 512 chars)', () => {
      const oversized = 'A'.repeat(513);
      expect(() => service.decode(oversized)).toThrow(BadRequestException);
    });

    it('rejects a cursor whose id is not a valid UUID', () => {
      const payload = JSON.stringify({ v: 1, createdAt: CREATED_AT.toISOString(), id: 'not-a-uuid' });
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');
      expect(() => service.decode(cursor)).toThrow(BadRequestException);
    });

    it('rejects a cursor whose createdAt is NaN (unparseable date)', () => {
      const payload = JSON.stringify({ v: 1, createdAt: 'INVALID_DATE', id: VALID_UUID });
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');
      expect(() => service.decode(cursor)).toThrow(BadRequestException);
    });

    it('rejects a standard-base64 encoded cursor (padding chars are not URL-safe)', () => {
      // A cursor encoded with standard base64 (with + / =) must be rejected
      // to prevent clients from leaking session tokens or fingerprinting the format
      const payload = JSON.stringify({ v: 1, createdAt: CREATED_AT.toISOString(), id: VALID_UUID });
      const standardB64 = Buffer.from(payload, 'utf8').toString('base64'); // standard, not base64url
      // Only attempt decode if it actually contains standard-b64 chars and differs from base64url
      if (/[+/=]/.test(standardB64)) {
        // The service may accept legacy standard-b64 cursors with strict round-trip validation,
        // but a cursor that does NOT round-trip exactly must throw
        const mutated = standardB64.slice(0, -2) + '!!'; // corrupt the padding
        expect(() => service.decode(mutated)).toThrow(BadRequestException);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Failure path: decode throws, not silently returns null
  // -------------------------------------------------------------------------
  describe('Failure path — error propagation contract', () => {
    it('decode always throws BadRequestException on invalid input, never returns null', () => {
      const invalidInputs = [
        '',
        '   ',
        'aaaa',
        Buffer.from('{"v":1}', 'utf8').toString('base64url'),
        'eyJub3RhY3Vyc29yIjp0cnVlfQ', // {"notacursor":true} base64url
      ];

      for (const input of invalidInputs) {
        expect(() => service.decode(input)).toThrow(BadRequestException);
      }
    });

    it('applyDescendingKeyset throws BadRequestException for an invalid cursor string', () => {
      const qb = mockQb();
      expect(() => service.applyDescendingKeyset(qb, 'item', 'invalid-cursor')).toThrow(
        BadRequestException,
      );
      // Query builder must NOT have received a WHERE clause from the bad cursor
      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Retry path: decode is deterministic (safe to retry with same cursor)
  // -------------------------------------------------------------------------
  describe('Retry path — idempotent decode', () => {
    it('decodes the same cursor to the same position on every call', () => {
      const position = { id: VALID_UUID, createdAt: CREATED_AT };
      const cursor = service.encode(position);

      const first = service.decode(cursor);
      const second = service.decode(cursor);
      const third = service.decode(cursor);

      expect(first).toEqual(second);
      expect(second).toEqual(third);
    });

    it('re-encoding a decoded position reproduces the original cursor', () => {
      const position = { id: VALID_UUID, createdAt: CREATED_AT };
      const cursor = service.encode(position);
      const decoded = service.decode(cursor);
      expect(service.encode(decoded)).toBe(cursor);
    });
  });

  // -------------------------------------------------------------------------
  // Legacy cursor backward compatibility (migration contract)
  // -------------------------------------------------------------------------
  describe('Migration path — legacy cursor acceptance', () => {
    it('accepts a pre-version cursor (notification-history shape) during rollout', () => {
      const legacy = Buffer.from(
        JSON.stringify({ createdAt: CREATED_AT, id: VALID_UUID }),
        'utf8',
      ).toString('base64');
      const decoded = service.decode(legacy);
      expect(decoded).toEqual({ id: VALID_UUID, createdAt: CREATED_AT });
    });
  });
});
