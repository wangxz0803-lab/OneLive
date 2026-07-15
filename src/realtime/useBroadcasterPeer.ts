import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BroadcasterSourceState,
  IceServerConfig,
  SenderConstraints,
  SourceCommand,
} from './protocol';
import {
  applySenderConstraints,
  safelyAddIceCandidate,
  toRtcConfiguration,
  type SenderParametersResult,
} from './peer-utils';
import type { OneLiveClientSocket } from './socket-session';

export type PeerUiState = 'idle' | 'waiting' | RTCPeerConnectionState;

export interface BroadcasterPeerOptions {
  socket: OneLiveClientSocket;
  sessionId: string;
  joined: boolean;
  epoch: number;
  controlPresent: boolean;
  stream: MediaStream | null;
  iceServers?: IceServerConfig[];
  initialConstraints?: SenderConstraints;
  sourceState?: BroadcasterSourceState;
  onCommand?: (command: SourceCommand) => void;
  onSenderParameters?: (result: SenderParametersResult) => void;
}

export interface BroadcasterPeerState {
  connectionState: PeerUiState;
  error: string | null;
  renegotiate: () => void;
  applyConstraints: (constraints: SenderConstraints) => Promise<SenderParametersResult>;
}

const defaultSourceState = (): BroadcasterSourceState => ({
  connection: 'ready',
  audioEnabled: true,
  videoEnabled: true,
  facingMode: 'unknown',
  updatedAt: Date.now(),
});

export const useBroadcasterPeer = ({
  socket,
  sessionId,
  joined,
  epoch,
  controlPresent,
  stream,
  iceServers = [],
  initialConstraints,
  sourceState,
  onCommand,
  onSenderParameters,
}: BroadcasterPeerOptions): BroadcasterPeerState => {
  const [connectionState, setConnectionState] = useState<PeerUiState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const commandCallbackRef = useRef(onCommand);
  const senderCallbackRef = useRef(onSenderParameters);
  const sourceStateRef = useRef(sourceState);
  const constraintsRef = useRef(initialConstraints);
  const iceServerKey = JSON.stringify(iceServers);
  const rtcConfiguration = useMemo(
    () => toRtcConfiguration(iceServers),
    // iceServerKey intentionally stabilizes equivalent configuration arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [iceServerKey],
  );

  useEffect(() => {
    commandCallbackRef.current = onCommand;
  }, [onCommand]);
  useEffect(() => {
    senderCallbackRef.current = onSenderParameters;
  }, [onSenderParameters]);
  useEffect(() => {
    sourceStateRef.current = sourceState;
    if (joined && sourceState) {
      const connection =
        peerRef.current?.connectionState === 'connected' ? 'streaming' : sourceState.connection;
      socket.emit('source:state', {
        sessionId,
        state: { ...sourceState, connection, updatedAt: Date.now() },
      });
    }
  }, [joined, sessionId, socket, sourceState]);

  const renegotiate = useCallback(() => setRestartKey((value) => value + 1), []);

  const applyConstraints = useCallback(
    async (constraints: SenderConstraints): Promise<SenderParametersResult> => {
      const peer = peerRef.current;
      if (!peer) return { applied: false, reason: 'Broadcaster peer is not ready.' };
      const result = await applySenderConstraints(peer, constraints);
      senderCallbackRef.current?.(result);
      return result;
    },
    [],
  );

  useEffect(() => {
    if (!initialConstraints) return;
    constraintsRef.current = initialConstraints;
    if (peerRef.current) void applyConstraints(initialConstraints);
  }, [applyConstraints, initialConstraints]);

  useEffect(() => {
    if (!joined) return;

    const handleCommand = (payload: { sessionId: string; command: SourceCommand }): void => {
      if (payload.sessionId !== sessionId) return;
      commandCallbackRef.current?.(payload.command);
      if (payload.command.type === 'set-sender-constraints') {
        constraintsRef.current = payload.command.constraints;
        if (peerRef.current) void applyConstraints(payload.command.constraints);
      } else if (payload.command.type === 'renegotiate') {
        renegotiate();
      }
    };

    socket.on('source:command', handleCommand);
    return () => {
      socket.off('source:command', handleCommand);
    };
  }, [applyConstraints, joined, renegotiate, sessionId, socket]);

  useEffect(() => {
    if (!joined || !controlPresent || !stream || epoch <= 0) {
      setConnectionState(joined ? 'waiting' : 'idle');
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') {
      setConnectionState('failed');
      setError('WebRTC is unavailable in this browser.');
      return;
    }

    let disposed = false;
    let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingRemoteCandidates: Array<RTCIceCandidateInit | null> = [];
    const offerEpoch = epoch + restartKey;

    const publishConnectionState = (connection: BroadcasterSourceState['connection']): void => {
      if (!socket.connected) return;
      const latest = sourceStateRef.current ?? defaultSourceState();
      socket.emit('source:state', {
        sessionId,
        state: { ...latest, connection, updatedAt: Date.now() },
      });
    };

    const handleAnswer = async (payload: {
      sessionId: string;
      epoch: number;
      description: RTCSessionDescriptionInit;
    }): Promise<void> => {
      const peer = peerRef.current;
      if (
        disposed ||
        !peer ||
        payload.sessionId !== sessionId ||
        payload.epoch !== offerEpoch ||
        payload.description.type !== 'answer'
      ) {
        return;
      }
      try {
        await peer.setRemoteDescription(payload.description);
        while (pendingRemoteCandidates.length > 0) {
          await safelyAddIceCandidate(peer, pendingRemoteCandidates.shift() ?? null);
        }
      } catch {
        setError('The desktop answer could not be applied; reconnecting is safe.');
      }
    };

    const handleIce = async (payload: {
      sessionId: string;
      epoch: number;
      candidate: RTCIceCandidateInit | null;
    }): Promise<void> => {
      const peer = peerRef.current;
      if (!peer || payload.sessionId !== sessionId || payload.epoch !== offerEpoch) return;
      if (!peer.remoteDescription) {
        pendingRemoteCandidates.push(payload.candidate);
        return;
      }
      await safelyAddIceCandidate(peer, payload.candidate);
    };

    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice', handleIce);

    const negotiate = async (): Promise<void> => {
      const previous = peerRef.current;
      peerRef.current = null;
      previous?.close();
      pendingRemoteCandidates.length = 0;

      const peer = new RTCPeerConnection(rtcConfiguration);
      peerRef.current = peer;
      setConnectionState('new');
      setError(null);
      publishConnectionState('reconnecting');

      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream);
      }

      peer.onicecandidate = (event) => {
        if (disposed || peerRef.current !== peer) return;
        socket.emit('webrtc:ice', {
          sessionId,
          epoch: offerEpoch,
          candidate: event.candidate?.toJSON() ?? null,
        });
      };
      peer.onconnectionstatechange = () => {
        if (disposed || peerRef.current !== peer) return;
        setConnectionState(peer.connectionState);
        if (peer.connectionState === 'connected') {
          if (disconnectedTimer) clearTimeout(disconnectedTimer);
          publishConnectionState('streaming');
        } else if (peer.connectionState === 'disconnected') {
          publishConnectionState('reconnecting');
          disconnectedTimer = setTimeout(() => {
            if (peer.connectionState === 'disconnected') renegotiate();
          }, 4_000);
        } else if (peer.connectionState === 'failed') {
          publishConnectionState('reconnecting');
          setTimeout(renegotiate, 250);
        }
      };

      try {
        if (constraintsRef.current) {
          const result = await applySenderConstraints(peer, constraintsRef.current);
          senderCallbackRef.current?.(result);
        }
        const offer = await peer.createOffer({ iceRestart: true });
        await peer.setLocalDescription(offer);
        if (disposed || peerRef.current !== peer || !peer.localDescription) return;
        socket.emit('webrtc:offer', {
          sessionId,
          epoch: offerEpoch,
          description: peer.localDescription,
        });
      } catch {
        if (disposed) return;
        setConnectionState('failed');
        setError('The camera stream could not start WebRTC. Mock Source remains available.');
        publishConnectionState('failed');
      }
    };

    void negotiate();
    return () => {
      disposed = true;
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice', handleIce);
      const peer = peerRef.current;
      if (peer) {
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }
      if (peerRef.current === peer) peerRef.current = null;
    };
  }, [
    applyConstraints,
    controlPresent,
    epoch,
    joined,
    renegotiate,
    restartKey,
    rtcConfiguration,
    sessionId,
    socket,
    stream,
  ]);

  return { connectionState, error, renegotiate, applyConstraints };
};
