function buildDisconnectInfo(socket, reason, studentName, context = {}) {
  const baseInfo = {
    timestamp: new Date().toISOString(),
    student: studentName,
    studentId: context.studentId ?? null,
    socketId: socket.id,
    reason,
    transport: socket.conn?.transport?.name,
    lastPing: socket.conn?.lastPing,
    pingTimeout: reason === 'ping timeout',
  };

  const sanitizedContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    sanitizedContext[key] = value;
  }

  return { ...baseInfo, ...sanitizedContext };
}

async function sendDisconnectWebhook(info) {
  const url = process.env.DISCONNECT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info),
    });
  } catch (err) {
    console.error('DISCONNECT_WEBHOOK error', err.message);
  }
}

module.exports = { buildDisconnectInfo, sendDisconnectWebhook };
