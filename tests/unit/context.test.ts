/**
 * Unit tests for getClientIp() in src/lib/context.ts
 *
 * Tests the correct extraction of client IP from Cloudflare Workers requests.
 */
import { describe, it, expect } from 'vitest';
import { getClientIp } from '@/lib/context';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://example.com/', { headers });
}

describe('getClientIp()', () => {
  it('returns CF-Connecting-IP when present (single trusted value)', () => {
    const req = makeRequest({ 'cf-connecting-ip': '1.2.3.4' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('trims whitespace from CF-Connecting-IP', () => {
    const req = makeRequest({ 'cf-connecting-ip': '  1.2.3.4  ' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For when both are present', () => {
    const req = makeRequest({
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8, 9.10.11.12',
    });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('extracts only the first IP from X-Forwarded-For when no CF-Connecting-IP', () => {
    const req = makeRequest({ 'x-forwarded-for': '10.0.0.1, 172.16.0.1, 192.168.1.1' });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('trims whitespace from X-Forwarded-For first entry', () => {
    const req = makeRequest({ 'x-forwarded-for': '  10.0.0.1  , 172.16.0.1' });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('handles single value in X-Forwarded-For', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.5' });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('returns empty string when no IP headers are present', () => {
    const req = makeRequest({});
    expect(getClientIp(req)).toBe('');
  });

  it('handles IPv6 addresses from CF-Connecting-IP', () => {
    const req = makeRequest({ 'cf-connecting-ip': '2001:db8::1' });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });

  it('handles IPv6 addresses from X-Forwarded-For', () => {
    const req = makeRequest({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });
});
