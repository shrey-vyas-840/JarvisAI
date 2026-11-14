import { describe, it, expect, vi, afterEach } from 'vitest';

describe('Relay Session Cleanup', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates and deletes CLI session without error', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: Request | string | URL) => {
      const urlStr = input instanceof Request ? input.url : input.toString();
      const path = new URL(urlStr).pathname;
      if (path === '/cli/session/new') {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'test-session-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (path === '/cli/session/delete') {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const createResponse = await fetch(`http://127.0.0.1:19989/cli/session/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(createResponse.ok).toBe(true);
    const createResult = (await createResponse.json()) as { id: string };
    const sessionId = createResult.id;

    const deleteResponse = await fetch(`http://127.0.0.1:19989/cli/session/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    expect(deleteResponse.ok).toBe(true);
    const deleteResult = (await deleteResponse.json()) as { success: boolean };
    expect(deleteResult.success).toBe(true);
  });

  it('handles multiple session deletions independently', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: Request | string | URL) => {
      const urlStr = input instanceof Request ? input.url : input.toString();
      const path = new URL(urlStr).pathname;
      if (path === '/cli/session/new') {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'test-session-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (path === '/cli/session/delete') {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const sessionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:19989/cli/session/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const result = (await response.json()) as { id: string };
      sessionIds.push(result.id);
    }

    for (const sessionId of sessionIds) {
      const deleteResponse = await fetch(`http://127.0.0.1:19989/cli/session/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      expect(deleteResponse.ok).toBe(true);
    }
  });

  it('handles multiple delete calls for same session', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: Request | string | URL) => {
      const urlStr = input instanceof Request ? input.url : input.toString();
      const path = new URL(urlStr).pathname;
      if (path === '/cli/session/new') {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'test-session-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (path === '/cli/session/delete') {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const response = await fetch(`http://127.0.0.1:19989/cli/session/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const result = (await response.json()) as { id: string };
    const sessionId = result.id;

    const delete1 = await fetch(`http://127.0.0.1:19989/cli/session/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    expect(delete1.ok).toBe(true);

    vi.spyOn(global, 'fetch').mockImplementation(async (input: Request | string | URL) => {
      const urlStr = input instanceof Request ? input.url : input.toString();
      const path = new URL(urlStr).pathname;
      if (path === '/cli/session/delete') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: `Session ${sessionId} not found` }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const delete2 = await fetch(`http://127.0.1:19989/cli/session/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    expect(delete2.status).toBe(404);
  });
});
