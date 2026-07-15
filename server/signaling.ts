import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  IceCandidateEnvelope,
  InterServerEvents,
  PeerRole,
  ServerToClientEvents,
  SessionDescriptionEnvelope,
  SessionJoinRequest,
  SocketData,
  SourceCommandEnvelope,
  SourceStateEnvelope,
} from '../src/realtime/protocol';
import { SESSION_ID_PATTERN } from '../src/realtime/protocol';
import { SessionRegistry } from './session-registry';

export type OneLiveSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type OneLiveSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

const invalid = (socket: OneLiveSocket, message: string): void => {
  socket.emit('server:error', { code: 'INVALID_MESSAGE', message });
};

const requireMembership = (
  socket: OneLiveSocket,
  sessionId: string,
  allowedRoles?: PeerRole[],
): { sessionId: string; role: PeerRole } | undefined => {
  if (!socket.data.sessionId || !socket.data.role || socket.data.sessionId !== sessionId) {
    socket.emit('server:error', {
      code: 'NOT_JOINED',
      message: 'Join this live session before sending realtime messages.',
    });
    return undefined;
  }

  if (allowedRoles && !allowedRoles.includes(socket.data.role)) {
    socket.emit('server:error', {
      code: 'WRONG_ROLE',
      message: 'This realtime message is not valid for the current device role.',
    });
    return undefined;
  }

  return { sessionId: socket.data.sessionId, role: socket.data.role };
};

const validDescription = (
  payload: SessionDescriptionEnvelope,
  expectedType: 'offer' | 'answer',
): boolean =>
  Boolean(
    payload &&
      SESSION_ID_PATTERN.test(payload.sessionId) &&
      Number.isSafeInteger(payload.epoch) &&
      payload.epoch > 0 &&
      payload.description?.type === expectedType &&
      typeof payload.description.sdp === 'string' &&
      payload.description.sdp.length < 256_000,
  );

const validIce = (payload: IceCandidateEnvelope): boolean =>
  Boolean(
    payload &&
      SESSION_ID_PATTERN.test(payload.sessionId) &&
      Number.isSafeInteger(payload.epoch) &&
      payload.epoch > 0 &&
      (payload.candidate === null || typeof payload.candidate === 'object'),
  );

export const installSignaling = (io: OneLiveSocketServer): (() => void) => {
  const registry = new SessionRegistry();
  const pruneTimer = setInterval(() => registry.prune(), 60_000);
  pruneTimer.unref();

  const broadcastPresence = (sessionId: string): void => {
    io.to(sessionId).emit('session:presence', registry.presence(sessionId));
  };

  io.on('connection', (socket) => {
    socket.on('session:join', async (payload: SessionJoinRequest, acknowledge) => {
      const sessionId = payload?.sessionId?.trim();
      const role = payload?.role;
      const clientId = payload?.clientId?.trim();

      if (
        !sessionId ||
        !SESSION_ID_PATTERN.test(sessionId) ||
        (role !== 'control' && role !== 'broadcaster') ||
        !clientId ||
        clientId.length > 128
      ) {
        acknowledge?.({ ok: false, error: 'Invalid session join request.' });
        return;
      }

      const previousSessionId = socket.data.sessionId;
      if (previousSessionId && previousSessionId !== sessionId) {
        await socket.leave(previousSessionId);
        registry.leave(socket.id);
        broadcastPresence(previousSessionId);
      }

      const { replacedSocketId } = registry.join(sessionId, role, socket.id);
      socket.data.sessionId = sessionId;
      socket.data.role = role;
      socket.data.clientId = clientId;
      await socket.join(sessionId);

      if (replacedSocketId) {
        const replaced = io.sockets.sockets.get(replacedSocketId);
        replaced?.emit('session:replaced', {
          code: 'SESSION_REPLACED',
          message: 'A newer device connection replaced this session role.',
        });
        replaced?.disconnect(true);
      }

      const presence = registry.presence(sessionId);
      acknowledge?.({ ok: true, presence });
      broadcastPresence(sessionId);
    });

    socket.on('webrtc:offer', (payload) => {
      if (!validDescription(payload, 'offer')) {
        invalid(socket, 'Invalid WebRTC offer.');
        return;
      }
      if (!requireMembership(socket, payload.sessionId, ['broadcaster'])) return;
      socket.to(payload.sessionId).emit('webrtc:offer', payload);
    });

    socket.on('webrtc:answer', (payload) => {
      if (!validDescription(payload, 'answer')) {
        invalid(socket, 'Invalid WebRTC answer.');
        return;
      }
      if (!requireMembership(socket, payload.sessionId, ['control'])) return;
      socket.to(payload.sessionId).emit('webrtc:answer', payload);
    });

    socket.on('webrtc:ice', (payload) => {
      if (!validIce(payload)) {
        invalid(socket, 'Invalid ICE candidate.');
        return;
      }
      if (!requireMembership(socket, payload.sessionId)) return;
      socket.to(payload.sessionId).emit('webrtc:ice', payload);
    });

    socket.on('source:state', (payload: SourceStateEnvelope) => {
      if (!payload || !SESSION_ID_PATTERN.test(payload.sessionId) || !payload.state) {
        invalid(socket, 'Invalid source state.');
        return;
      }
      if (!requireMembership(socket, payload.sessionId, ['broadcaster'])) return;
      socket.to(payload.sessionId).emit('source:state', payload);
    });

    socket.on('source:command', (payload: SourceCommandEnvelope) => {
      if (!payload || !SESSION_ID_PATTERN.test(payload.sessionId) || !payload.command) {
        invalid(socket, 'Invalid source command.');
        return;
      }
      if (!requireMembership(socket, payload.sessionId, ['control'])) return;
      socket.to(payload.sessionId).emit('source:command', payload);
    });

    socket.on('disconnect', () => {
      const membership = registry.getMembership(socket.id);
      registry.leave(socket.id);
      if (membership) broadcastPresence(membership.sessionId);
    });
  });

  return () => clearInterval(pruneTimer);
};

