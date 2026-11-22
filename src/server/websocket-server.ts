import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom, GameMessage } from './game-room.js';
import { RoundEvent } from '../engine/round-state-machine.js';
import { TileInstance } from '../types/tiles.js';
import { GameState, Wind, GameLength } from '../types/game-state.js';

/**
 * Client message types
 */
export type ClientMessage =
  | { type: 'join_room'; roomId: string; playerId: string; gameLength?: GameLength }
  | { type: 'set_game_length'; gameLength: GameLength }
  | { type: 'game_action'; event: RoundEvent }
  | { type: 'pass_call' }
  | { type: 'set_wall'; wall: TileInstance[] }
  | { type: 'set_matchmaking_timeout'; timeoutMs: number }
  | { type: 'get_state' };

/**
 * Server message types
 */
export type ServerMessage =
  | { type: 'joined'; roomId: string; playerId: string; seat?: Wind }
  | { type: 'game_update'; messages: GameMessage[] }
  | { type: 'state'; state: any }
  | { type: 'error'; error: string };

export interface WebSocketServerOptions {
  /** Matchmaking wait time (ms) before replenishing empty seats with NPCs and auto-starting (default: 60000 = 1 minute) */
  matchmakingTimeoutMs?: number;
}

/**
 * WebSocket server for mahjong game
 * Server-authoritative: validates all actions and maintains game state
 */
export class MahjongWebSocketServer {
  private wss: WebSocketServer;
  private rooms: Map<string, GameRoom>;
  private clients: Map<WebSocket, ClientConnection>;
  private npcTimers: Map<string, NodeJS.Timeout>;
  private matchmakingTimers: Map<string, NodeJS.Timeout>;
  private matchmakingTimeoutMs: number;

  constructor(port: number, options?: WebSocketServerOptions) {
    this.wss = new WebSocketServer({ port });
    this.rooms = new Map();
    this.clients = new Map();
    this.npcTimers = new Map();
    this.matchmakingTimers = new Map();
    this.matchmakingTimeoutMs = options?.matchmakingTimeoutMs ?? 60_000;

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
      const conn = this.clients.get(ws);
      this.clients.delete(ws);
      if (conn?.roomId && conn?.playerId) {
        const stillConnected = Array.from(this.clients.values()).some(
          c => c.roomId === conn.roomId && c.playerId === conn.playerId
        );
        if (!stillConnected) {
          const room = this.rooms.get(conn.roomId);
          if (room) {
            room.releasePlayer(conn.playerId);
            if (room.getState().phase === 'waiting' && room.getHumanCount() === 0) {
              this.clearMatchmakingTimer(conn.roomId);
              room.getState().autoStartDeadline = null;
            }
            this.broadcastToRoom(conn.roomId, {
              type: 'state',
              state: room.getState()
            });
            this.scheduleNpcTurn(conn.roomId, 250);
          }
        }
      }
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
        this.handleJoinRoom(ws, message.roomId, message.playerId, message.gameLength);
        break;

      case 'set_game_length':
        this.handleSetGameLength(ws, message.gameLength);
        break;

      case 'game_action':
        this.handleGameAction(ws, message.event);
        break;

      case 'pass_call':
        this.handlePassCall(ws);
        break;

      case 'set_wall':
        this.handleSetWall(ws, message.wall);
        break;

      case 'set_matchmaking_timeout':
        this.handleSetMatchmakingTimeout(ws, message.timeoutMs);
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

    this.clearNpcTimer(connection.roomId);
    this.clearMatchmakingTimer(connection.roomId);
    room.setupRoundWithWall(wall);
    const startMessages = room.autoStartRound();
    this.broadcastToRoom(connection.roomId, {
      type: 'state',
      state: room.getState()
    });
    this.broadcastToRoom(connection.roomId, {
      type: 'game_update',
      messages: [
        { type: 'game_event', event: `Custom wall set (${wall.length} tiles). Round auto-started.` },
        ...startMessages
      ]
    });
    this.scheduleNpcTurn(connection.roomId, 500);
  }

  /**
   * Handle join room request
   */
  private handleJoinRoom(ws: WebSocket, roomId: string, playerId: string, gameLength?: GameLength): void {
    const connection = this.clients.get(ws);
    if (!connection) return;

    const isNewRoom = !this.rooms.has(roomId);
    // Create room if it doesn't exist
    if (isNewRoom) {
      const room = new GameRoom('rules/default.rule.json');
      this.rooms.set(roomId, room);
      console.log(`Created room: ${roomId}`);
    }

    const room = this.rooms.get(roomId)!;
    if (gameLength && (isNewRoom || room.getHumanCount() === 0)) {
      room.setGameLength(gameLength);
    }
    const assignedSeat = room.assignPlayer(playerId);

    // Join room
    connection.roomId = roomId;
    connection.playerId = playerId;

    const response: ServerMessage = {
      type: 'joined',
      roomId,
      playerId,
      seat: assignedSeat
    };

    ws.send(JSON.stringify(response));
    console.log(`Player ${playerId} joined room ${roomId} (seat: ${assignedSeat})`);

    // Automatic round start & matchmaking logic:
    // Condition A: 4 human players have gathered -> start immediately!
    // Condition B: 1-3 human players -> wait 1 minute (matchmakingTimeoutMs); if still < 4, fill NPCs and start!
    if (room.getState().phase === 'waiting') {
      const humanCount = room.getHumanCount();
      if (humanCount >= 4) {
        this.clearMatchmakingTimer(roomId);
        const startMessages = room.autoStartRound();
        this.broadcastToRoom(roomId, {
          type: 'state',
          state: room.getState()
        });
        this.broadcastToRoom(roomId, {
          type: 'game_update',
          messages: [
            { type: 'game_event', event: '4 players gathered! Starting round automatically.' },
            ...startMessages
          ]
        });
        return;
      } else if (humanCount >= 1) {
        this.scheduleMatchmakingAutoStart(roomId);
      }
    }

    // Broadcast current state to all clients in room
    this.broadcastToRoom(roomId, {
      type: 'state',
      state: room.getState()
    });
  }

  /**
   * Schedule automatic NPC replenishment & round start after 1 minute (matchmakingTimeoutMs) if < 4 humans gather
   */
  private scheduleMatchmakingAutoStart(roomId: string): void {
    if (this.matchmakingTimers.has(roomId)) {
      return; // Timer already ticking from the first player's arrival
    }
    const room = this.rooms.get(roomId);
    if (!room || room.getState().phase !== 'waiting') return;

    room.getState().autoStartDeadline = Date.now() + this.matchmakingTimeoutMs;

    const timer = setTimeout(() => {
      this.matchmakingTimers.delete(roomId);
      const currentRoom = this.rooms.get(roomId);
      if (!currentRoom || currentRoom.getState().phase !== 'waiting') return;

      const humanCount = currentRoom.getHumanCount();
      if (humanCount >= 1 && humanCount < 4) {
        const npcCount = 4 - humanCount;
        const startMessages = currentRoom.autoStartRound();
        this.broadcastToRoom(roomId, {
          type: 'state',
          state: currentRoom.getState()
        });
        this.broadcastToRoom(roomId, {
          type: 'game_update',
          messages: [
            {
              type: 'game_event',
              event: `Matchmaking timeout reached with ${humanCount} player(s). Replenished ${npcCount} NPC(s) and started round automatically.`
            },
            ...startMessages
          ]
        });
        this.scheduleNpcTurn(roomId, 500);
      }
    }, this.matchmakingTimeoutMs);

    this.matchmakingTimers.set(roomId, timer);
  }

  private clearMatchmakingTimer(roomId: string): void {
    const timer = this.matchmakingTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.matchmakingTimers.delete(roomId);
    }
  }

  /**
   * Handle set game length request ('east' = 東風戦, 'south' = 東南戦)
   */
  private handleSetGameLength(ws: WebSocket, gameLength: GameLength): void {
    const connection = this.clients.get(ws);
    if (!connection || !connection.roomId) return;
    const room = this.rooms.get(connection.roomId);
    if (!room) return;
    if (gameLength === 'east' || gameLength === 'south') {
      room.setGameLength(gameLength);
      this.broadcastToRoom(connection.roomId, {
        type: 'state',
        state: room.getState()
      });
    }
  }

  /**
   * Adjust matchmaking timeout for the current room (e.g. to fast-forward the 1-minute wait in automated tests)
   */
  private handleSetMatchmakingTimeout(ws: WebSocket, timeoutMs: number): void {
    const connection = this.clients.get(ws);
    if (!connection || !connection.roomId) return;
    const roomId = connection.roomId;
    const room = this.rooms.get(roomId);
    if (!room || room.getState().phase !== 'waiting') return;

    this.clearMatchmakingTimer(roomId);
    const prevTimeout = this.matchmakingTimeoutMs;
    this.matchmakingTimeoutMs = Math.max(50, timeoutMs);
    this.scheduleMatchmakingAutoStart(roomId);
    this.matchmakingTimeoutMs = prevTimeout;
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
    const allMessages = [...result.messages];

    // If ROUND_END transitioned back to waiting and 4 players (humans/NPCs) are seated, automatically start the next round!
    if (event.type === 'ROUND_END' && room.getState().phase === 'waiting' && room.getOccupiedCount() === 4) {
      const nextRoundMsgs = room.autoStartRound();
      allMessages.push(...nextRoundMsgs);
    }

    // Broadcast to all clients in room
    const response: ServerMessage = {
      type: 'game_update',
      messages: allMessages
    };

    this.broadcastToRoom(connection.roomId, response);

    // Schedule NPC turn progression if room has NPC players
    // (Use a 500ms initial wait on round/deal start, and 280ms between turns)
    const initialWait = (event.type === 'DEAL_COMPLETE' || event.type === 'ROUND_START' || event.type === 'ROUND_END') ? 500 : 280;
    this.scheduleNpcTurn(connection.roomId, initialWait);
  }

  /**
   * Handle human player passing on a call/ron opportunity
   */
  private handlePassCall(ws: WebSocket): void {
    const connection = this.clients.get(ws);
    if (!connection || !connection.roomId || !connection.playerId) return;

    const room = this.rooms.get(connection.roomId);
    if (!room) return;

    room.markPlayerPassedCall(connection.playerId);
    this.scheduleNpcTurn(connection.roomId, 80);
  }

  private clearNpcTimer(roomId: string): void {
    const timer = this.npcTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.npcTimers.delete(roomId);
    }
  }

  /**
   * Schedule automatic NPC turn progression
   */
  private scheduleNpcTurn(roomId: string, delayMs = 180): void {
    this.clearNpcTimer(roomId);
    const room = this.rooms.get(roomId);
    if (!room || !room.hasNpcPlayers() || room.getState().phase !== 'playing') {
      return;
    }

    const timer = setTimeout(() => {
      this.npcTimers.delete(roomId);
      const currentRoom = this.rooms.get(roomId);
      if (!currentRoom || !currentRoom.hasNpcPlayers() || currentRoom.getState().phase !== 'playing') {
        return;
      }

      const stepResult = currentRoom.stepNpc();
      if (stepResult.acted && stepResult.messages.length > 0) {
        this.broadcastToRoom(roomId, {
          type: 'game_update',
          messages: stepResult.messages
        });
        if (currentRoom.getState().phase === 'playing') {
          this.scheduleNpcTurn(roomId, 280);
        }
      }
    }, delayMs);

    this.npcTimers.set(roomId, timer);
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
      state: this.sanitizeStateForClient(room.getState(), connection.playerId)
    };

    ws.send(JSON.stringify(response));
  }

  /**
   * Sanitize GameState for a specific recipient client to hide other players' hands, wall order, and ura-dora during active play
   */
  private sanitizeStateForClient(state: GameState, playerId: string | null): GameState {
    const revealAll = ['ron_declared', 'tsumo_declared', 'scoring', 'draw', 'round_end', 'game_end'].includes(state.phase);
    if (revealAll) {
      return state;
    }

    const maskedTile: TileInstance = { id: 'hidden', suit: 'man', rank: 1 };
    return {
      ...state,
      wall: state.wall.map((_, idx) => ({ ...maskedTile, id: `wall-hidden-${idx}` })),
      deadWall: state.deadWall.map((_, idx) => ({ ...maskedTile, id: `dw-hidden-${idx}` })),
      uraDoraIndicators: state.uraDoraIndicators.map((_, idx) => ({ ...maskedTile, id: `ura-hidden-${idx}` })),
      players: state.players.map(p => {
        if (playerId && p.id === playerId) {
          return p;
        }
        return {
          ...p,
          hand: p.hand.map((_, idx) => ({ ...maskedTile, id: `hand-hidden-${p.seat}-${idx}` }))
        };
      })
    };
  }

  /**
   * Sanitize a ServerMessage for a specific client
   */
  private sanitizeMessageForClient(message: ServerMessage, playerId: string | null): ServerMessage {
    if (message.type === 'state') {
      return {
        type: 'state',
        state: this.sanitizeStateForClient(message.state, playerId)
      };
    }
    if (message.type === 'game_update') {
      return {
        type: 'game_update',
        messages: message.messages.map(m => {
          if (m.type === 'state_update') {
            return {
              type: 'state_update',
              state: this.sanitizeStateForClient(m.state, playerId)
            };
          }
          return m;
        })
      };
    }
    return message;
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
   * Broadcast message to all clients in a room (with per-client state masking)
   */
  private broadcastToRoom(roomId: string, message: ServerMessage): void {
    this.clients.forEach((connection, ws) => {
      if (connection.roomId === roomId && ws.readyState === WebSocket.OPEN) {
        const sanitized = this.sanitizeMessageForClient(message, connection.playerId);
        ws.send(JSON.stringify(sanitized));
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
    this.npcTimers.forEach(t => clearTimeout(t));
    this.npcTimers.clear();
    this.matchmakingTimers.forEach(t => clearTimeout(t));
    this.matchmakingTimers.clear();
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
