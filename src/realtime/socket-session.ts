import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  PeerRole,
  RuntimeConfig,
  ServerErrorMessage,
  ServerToClientEvents,
  SessionPresence,
} from './protocol';

export type OneLiveClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SessionSocketOptions {
  sessionId: string;
  role: PeerRole;
  enabled?: boolean;
  url?: string;
  path?: string;
  clientId?: string;
}

export interface SessionSocketState {
  socket: OneLiveClientSocket;
  connected: boolean;
  joined: boolean;
  presence: SessionPresence | null;
  epoch: number;
  error: string | null;
}

const createClientId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `onelive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const createEpoch = (): number => {
  const randomPart = Math.floor(Math.random() * 1_000);
  return Date.now() * 1_000 + randomPart;
};

export const fetchRuntimeConfig = async (signal?: AbortSignal): Promise<RuntimeConfig> => {
  const response = await fetch('/api/config', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    throw new Error('OneLive runtime configuration is unavailable.');
  }
  return (await response.json()) as RuntimeConfig;
};

export const useSessionSocket = ({
  sessionId,
  role,
  enabled = true,
  url,
  path = '/socket.io',
  clientId,
}: SessionSocketOptions): SessionSocketState => {
  const generatedClientId = useRef(clientId ?? createClientId());
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [presence, setPresence] = useState<SessionPresence | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const socket = useMemo<OneLiveClientSocket>(
    () =>
      io(url, {
        path,
        autoConnect: false,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5_000,
        timeout: 8_000,
      }) as OneLiveClientSocket,
    [path, url],
  );

  useEffect(() => {
    if (!enabled) {
      socket.disconnect();
      setConnected(false);
      setJoined(false);
      return;
    }

    const join = (): void => {
      const nextEpoch = createEpoch();
      setEpoch(nextEpoch);
      setJoined(false);
      socket.emit(
        'session:join',
        { sessionId, role, clientId: generatedClientId.current },
        (result) => {
          if (!result?.ok) {
            setError(result?.error ?? 'Could not join the OneLive session.');
            setJoined(false);
            return;
          }
          setPresence(result.presence);
          setJoined(true);
          setError(null);
        },
      );
    };
    const handleConnect = (): void => {
      setConnected(true);
      setError(null);
      join();
    };
    const handleDisconnect = (): void => {
      setConnected(false);
      setJoined(false);
    };
    const handlePresence = (nextPresence: SessionPresence): void => {
      if (nextPresence.sessionId === sessionId) setPresence(nextPresence);
    };
    const handleServerError = (message: ServerErrorMessage): void => {
      setError(message.message);
    };
    const handleConnectError = (): void => {
      setError('Realtime signaling is reconnecting…');
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('session:presence', handlePresence);
    socket.on('session:replaced', handleServerError);
    socket.on('server:error', handleServerError);

    if (socket.connected) handleConnect();
    else socket.connect();

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('session:presence', handlePresence);
      socket.off('session:replaced', handleServerError);
      socket.off('server:error', handleServerError);
      socket.disconnect();
    };
  }, [enabled, role, sessionId, socket]);

  return { socket, connected, joined, presence, epoch, error };
};
