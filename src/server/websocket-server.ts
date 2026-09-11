import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom, GameMessage } from './game-room.js';
import { RoundEvent } from '../engine/round-state-machine.js';
import { TileInstance } from '../types/tiles.js';

/**
 * Client message types
 */
export type ClientMessage =
  | { type: 'join_room'; roomId: string; playerId: string }
  | { type: 'game_action'; event: RoundEvent }
  | { type: 'set_wall'; wall: TileInstance[] }
  | { type: 'get_state' };

/**
 * Server message types
 */
export type ServerMessage =
  | { type: 'joined'; roomId: string; playerId: string }
  | { type: 'game_update'; messages: GameMessage[] }
  | { type: 'state'; state: any }
  | { type: 'error'; error: string };

/**
 * WebSocket server for mahjong game
 * Server-authoritative: validates all actions and maintains game state
 */
export class MahjongWebSocketServer {
  private wss: WebSocketServer;
  private rooms: Map<string, GameRoom>;
  private clients: Map<WebSocket, ClientConnection>;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.rooms = new Map();
    this.clients = new Map();

    this.wss.on('connection', (ws) => {
      this.handleConnection(ws);
    });

    console.log(`Mahjong WebSocket server listening on port ${port}`);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    console.log('New client connected');

    const connection: ClientConnection = {
      ws,
      roomId: null,
      playerId: null
    };

    this.clients.set(ws, connection);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleMessage(ws, message);
      } catch (error) {
        this.sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      this.clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  /**
   * Handle client message
   */
  private handleMessage(ws: WebSocket, message: ClientMessage): void {
    switch (message.type) {
      case 'join_room':
        this.handleJoinRoom(ws, message.roomId, message.playerId);
        break;

      case 'game_action':
        this.handleGameAction(ws, message.event);
        break;

      case 'set_wall':
        this.handleSetWall(ws, message.wall);
        break;

      case 'get_state':
        this.handleGetState(ws);
        break;

      default:
        this.sendError(ws, 'Unknown message type');
    }
  }

  /**
   * Handle set wall request (for replay or deterministic test scenario)
   */
  private handleSetWall(ws: WebSocket, wall: TileInstance[]): void {
    const connection = this.clients.get(ws);
    if (!connection || !connection.roomId) {
      this.sendError(ws, 'Not in a room');
      return;
    }

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      this.sendError(ws, 'Room not found');
      return;
    }

    room.setupRoundWithWall(wall);
    this.broadcastToRoom(connection.roomId, {
      type: 'state',
      state: room.getState()
    });
    this.broadcastToRoom(connection.roomId, {
      type: 'game_update',
      messages: [{ type: 'game_event', event: `Custom wall set (${wall.length} tiles). Round reset to waiting.` }]
    });
  }

  /**
   * Handle join room request
   */
  private handleJoinRoom(ws: WebSocket, roomId: string, playerId: string): void {
    const connection = this.clients.get(ws);
    if (!connection) return;

    // Create room if it doesn't exist
    if (!this.rooms.has(roomId)) {
      const room = new GameRoom('rules/default.rule.json');
      this.rooms.set(roomId, room);
      console.log(`Created room: ${roomId}`);
    }

    const room = this.rooms.get(roomId)!;
    room.assignPlayer(playerId);

    // Join room
    connection.roomId = roomId;
    connection.playerId = playerId;

    const response: ServerMessage = {
      type: 'joined',
      roomId,
      playerId
    };

    ws.send(JSON.stringify(response));
    console.log(`Player ${playerId} joined room ${roomId}`);

    // Broadcast current state to all clients in room
    this.broadcastToRoom(roomId, {
      type: 'state',
      state: room.getState()
    });
  }

  /**
   * Handle game action
   */
  private handleGameAction(ws: WebSocket, event: RoundEvent): void {
    const connection = this.clients.get(ws);
    if (!connection || !connection.roomId) {
      this.sendError(ws, 'Not in a room');
      return;
    }

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      this.sendError(ws, 'Room not found');
      return;
    }

    // Process event (server-authoritative)
    const result = room.processEvent(event);

    // Broadcast to all clients in room
    const response: ServerMessage = {
      type: 'game_update',
      messages: result.messages
    };

    this.broadcastToRoom(connection.roomId, response);
  }

  /**
   * Handle get state request
   */
  private handleGetState(ws: WebSocket): void {
    const connection = this.clients.get(ws);
    if (!connection || !connection.roomId) {
      this.sendError(ws, 'Not in a room');
      return;
    }

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      this.sendError(ws, 'Room not found');
      return;
    }

    const response: ServerMessage = {
      type: 'state',
      state: room.getState()
    };

    ws.send(JSON.stringify(response));
  }

  /**
   * Send error message to client
   */
  private sendError(ws: WebSocket, error: string): void {
    const response: ServerMessage = {
      type: 'error',
      error
    };
    ws.send(JSON.stringify(response));
  }

  /**
   * Broadcast message to all clients in a room
   */
  private broadcastToRoom(roomId: string, message: ServerMessage): void {
    const messageStr = JSON.stringify(message);

    this.clients.forEach((connection, ws) => {
      if (connection.roomId === roomId && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    });
  }

  /**
   * Get room
   */
  getRoom(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Close server
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        console.log('Server closed');
        resolve();
      });
    });
  }
}

/**
 * Client connection info
 */
interface ClientConnection {
  ws: WebSocket;
  roomId: string | null;
  playerId: string | null;
}
