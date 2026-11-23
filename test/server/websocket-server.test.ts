import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MahjongWebSocketServer } from '../../src/server/websocket-server.js';
import type { TileInstance } from '../../src/types/tiles.js';

const servers: MahjongWebSocketServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try { ws.terminate(); } catch { /* already closed */ }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(options?: { enableDebugMessages?: boolean }): Promise<{ server: MahjongWebSocketServer; port: number }> {
  const server = new MahjongWebSocketServer(0, options);
  servers.push(server);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return { server, port: server.getPort() };
    } catch {
      if (Date.now() > deadline) throw new Error('Timed out waiting for server to listen');
      await new Promise(r => setTimeout(r, 20));
    }
  }
}

async function connect(port: number): Promise<{ ws: WebSocket; received: any[] }> {
  const received: any[] = [];
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  for (;;) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
      });
      ws.on('message', (data) => {
        received.push(JSON.parse(data.toString()));
      });
      sockets.push(ws);
      return { ws, received };
    } catch (err) {
      lastError = err;
      if (Date.now() > deadline) throw lastError;
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

async function waitForMessage(received: any[], predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = received.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for message. Received: ${JSON.stringify(received)}`);
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

function buildWall(count: number): TileInstance[] {
  const wall: TileInstance[] = [];
  for (let i = 0; i < count; i++) {
    wall.push({ id: `test-${i}`, suit: 'man', rank: (i % 9) + 1 });
  }
  return wall;
}

describe('WebSocketServer - debug message gate', () => {
  it('should reject set_wall by default', async () => {
    const { port } = await startServer();
    const { ws, received } = await connect(port);

    ws.send(JSON.stringify({ type: 'join_room', roomId: 'gate-test-1', playerId: 'human1' }));
    await waitForMessage(received, (m) => m.type === 'joined');

    ws.send(JSON.stringify({ type: 'set_wall', wall: buildWall(136) }));
    const err = await waitForMessage(received, (m) => m.type === 'error');
    assert.equal(err.error, 'Debug messages are disabled on this server');
  });

  it('should reject set_matchmaking_timeout by default', async () => {
    const { port } = await startServer();
    const { ws, received } = await connect(port);

    ws.send(JSON.stringify({ type: 'join_room', roomId: 'gate-test-2', playerId: 'human1' }));
    await waitForMessage(received, (m) => m.type === 'joined');

    ws.send(JSON.stringify({ type: 'set_matchmaking_timeout', timeoutMs: 100 }));
    const err = await waitForMessage(received, (m) => m.type === 'error');
    assert.equal(err.error, 'Debug messages are disabled on this server');
  });

  it('should accept set_wall when debug messages are enabled', async () => {
    const { server, port } = await startServer({ enableDebugMessages: true });
    const { ws, received } = await connect(port);

    ws.send(JSON.stringify({ type: 'join_room', roomId: 'gate-test-3', playerId: 'human1' }));
    await waitForMessage(received, (m) => m.type === 'joined');

    ws.send(JSON.stringify({ type: 'set_wall', wall: buildWall(136) }));
    await waitForMessage(received, (m) =>
      m.type === 'game_update' && m.messages.some((msg: any) =>
        msg.type === 'game_event' && String(msg.event).includes('Custom wall set')));

    const errors = received.filter((m) => m.type === 'error');
    assert.equal(errors.length, 0);
    assert.equal(server.getRoom('gate-test-3')?.getPhase(), 'playing');
  });
});
