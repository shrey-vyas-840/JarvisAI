import { describe, it, expect } from 'vitest';

import { validateBrowserUrl } from '../../src/browser/url-guard.js';

describe('validateBrowserUrl', () => {
  it('accepts valid public HTTP and HTTPS URLs', () => {
    const res1 = validateBrowserUrl('https://example.com/test?page=1');
    expect(res1.valid).toBe(true);
    expect(res1.sanitizedUrl).toBe('https://example.com/test?page=1');

    const res2 = validateBrowserUrl('http://wikipedia.org');
    expect(res2.valid).toBe(true);
    expect(res2.sanitizedUrl).toBe('http://wikipedia.org/');
  });

  it('rejects empty or malformed URLs', () => {
    expect(validateBrowserUrl('').valid).toBe(false);
    expect(validateBrowserUrl('   ').valid).toBe(false);
    expect(validateBrowserUrl('not-a-valid-url').valid).toBe(false);
  });

  it('rejects dangerous and forbidden URL schemes', () => {
    const schemes = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(document.cookie)',
      'file:///C:/Windows/System32/cmd.exe',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:MsgBox("test")',
      'about:blank',
      'blob:https://example.com/uuid',
    ];

    for (const url of schemes) {
      const res = validateBrowserUrl(url);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/prohibited|Dangerous|Disallowed/);
    }
  });

  it('rejects localhost, loopback, and private IPv4/IPv6 networks by default', () => {
    const privateTargets = [
      'http://localhost:8080',
      'https://localhost',
      'http://127.0.0.1:3000',
      'http://127.0.0.2',
      'http://0.0.0.0:80',
      'http://192.168.1.100',
      'http://10.0.0.1/admin',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]:8080',
    ];

    for (const url of privateTargets) {
      const res = validateBrowserUrl(url);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/blocked|prohibited/);
    }
  });

  it('permits localhost when explicitly configured for local test harness', () => {
    const res = validateBrowserUrl('http://127.0.0.1:8080/test', { allowLocalhost: true });
    expect(res.valid).toBe(true);
    expect(res.sanitizedUrl).toBe('http://127.0.0.1:8080/test');
  });
});
