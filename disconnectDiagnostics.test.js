const { buildDisconnectInfo, sendDisconnectWebhook } = require('./disconnectDiagnostics');

describe('disconnect diagnostics', () => {
  test('buildDisconnectInfo collects details', () => {
    const socket = {
      id: '123',
      conn: { transport: { name: 'polling' }, lastPing: 42 }
    };
    const info = buildDisconnectInfo(socket, 'ping timeout', 'Alice', {
      studentId: 'stu-1',
      remainingSockets: 0,
      cleanupDelayMs: 15000,
    });
    expect(info).toEqual(expect.objectContaining({
      student: 'Alice',
      studentId: 'stu-1',
      socketId: '123',
      reason: 'ping timeout',
      transport: 'polling',
      lastPing: 42,
      pingTimeout: true,
      remainingSockets: 0,
      cleanupDelayMs: 15000,
    }));
    expect(info.timestamp).toEqual(expect.any(String));
  });

  test('sendDisconnectWebhook posts when url provided', async () => {
    const info = { sample: 'data' };
    const mockFetch = jest.fn().mockResolvedValue({});
    global.fetch = mockFetch;
    process.env.DISCONNECT_WEBHOOK = 'http://example.com/webhook';
    await sendDisconnectWebhook(info);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info),
      })
    );
    delete process.env.DISCONNECT_WEBHOOK;
    delete global.fetch;
  });

  test('sendDisconnectWebhook no-op when url missing', async () => {
    const info = { sample: 'data' };
    const mockFetch = jest.fn();
    global.fetch = mockFetch;
    delete process.env.DISCONNECT_WEBHOOK;
    await sendDisconnectWebhook(info);
    expect(mockFetch).not.toHaveBeenCalled();
    delete global.fetch;
  });
});
