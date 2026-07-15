import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BroadcasterSourceState, IceServerConfig, SourceCommandEnvelope } from './protocol';
import { safelyAddIceCandidate, toRtcConfiguration } from './peer-utils';
import type { OneLiveClientSocket } from './socket-session';
import { startStatsCollector, type WebRtcLiveStats } from './stats';
import type { PeerUiState } from './useBroadcasterPeer';

export interface ViewerPeerOptions {
  socket: OneLiveClientSocket;
  sessionId: string;
  joined: boolean;
  broadcasterPresent: boolean;
  iceServers?: IceServerConfig[];
  onStats?: (stats: WebRtcLiveStats) => void;
  onSourceState?: (state: BroadcasterSourceState) => void;
}

export interface ViewerPeerState {
  connectionState: PeerUiState;
  remoteStream: MediaStream | null;
  error: string | null;
  requestRenegotiation: () => void;
}

export const useViewerPeer = ({
  socket,
  sessionId,
  joined,
  broadcasterPresent,
  iceServers = [],
  onStats,
  onSourceState,
}: ViewerPeerOptions): ViewerPeerState => {
  const [connectionState, setConnectionState] = useState<PeerUiState>('idle');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerEpochRef = useRef(0);
  const statsCallbackRef = useRef(onStats);
  const sourceCallbackRef = useRef(onSourceState);
  const stopStatsRef = useRef<(() => void) | null>(null);
  const iceServerKey = JSON.stringify(iceServers);
  const rtcConfiguration = useMemo(
    () => toRtcConfiguration(iceServers),
    // iceServerKey intentionally stabilizes equivalent configuration arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [iceServerKey],
  );

  useEffect(() => {
    statsCallbackRef.current = onStats;
  }, [onStats]);
  useEffect(() => {
    sourceCallbackRef.current = onSourceState;
  }, [onSourceState]);

  const requestRenegotiation = useCallback(() => {
    if (!joined || !socket.connected) return;
    const payload: SourceCommandEnvelope = {
      sessionId,
      command: { type: 'renegotiate' },
    };
    socket.emit('source:command', payload);
  }, [joined, sessionId, socket]);

  useEffect(() => {
    if (!joined) {
      setConnectionState('idle');
      setRemoteStream(null);
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') {
      setConnectionState('failed');
      setError('WebRTC is unavailable in this browser.');
      return;
    }

    let disposed = false;
    let operation = 0;
    let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
    const candidateQueues = new Map<number, Array<RTCIceCandidateInit | null>>();

    const closePeer = (): void => {
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      stopStatsRef.current?.();
      stopStatsRef.current = null;
      const peer = peerRef.current;
      if (peer) {
        peer.ontrack = null;
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }
      peerRef.current = null;
      peerEpochRef.current = 0;
      remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
      remoteStreamRef.current = null;
      if (!disposed) setRemoteStream(null);
    };

    const handleOffer = async (payload: {
      sessionId: string;
      epoch: number;
      description: RTCSessionDescriptionInit;
    }): Promise<void> => {
      if (payload.sessionId !== sessionId || payload.description.type !== 'offer') return;
      const currentOperation = ++operation;
      closePeer();
      const peer = new RTCPeerConnection(rtcConfiguration);
      peerRef.current = peer;
      peerEpochRef.current = payload.epoch;
      setConnectionState('new');
      setError(null);

      peer.onicecandidate = (event) => {
        if (disposed || peerRef.current !== peer) return;
        socket.emit('webrtc:ice', {
          sessionId,
          epoch: payload.epoch,
          candidate: event.candidate?.toJSON() ?? null,
        });
      };
      peer.ontrack = (event) => {
        if (disposed || peerRef.current !== peer) return;
        const providedStream = event.streams[0];
        if (providedStream) {
          remoteStreamRef.current = providedStream;
          setRemoteStream(providedStream);
          return;
        }
        setRemoteStream((currentStream) => {
          const nextStream = currentStream ?? new MediaStream();
          if (!nextStream.getTracks().some((track) => track.id === event.track.id)) {
            nextStream.addTrack(event.track);
          }
          remoteStreamRef.current = nextStream;
          return nextStream;
        });
      };
      peer.onconnectionstatechange = () => {
        if (disposed || peerRef.current !== peer) return;
        setConnectionState(peer.connectionState);
        if (peer.connectionState === 'connected') {
          if (disconnectedTimer) clearTimeout(disconnectedTimer);
        } else if (peer.connectionState === 'disconnected') {
          disconnectedTimer = setTimeout(() => {
            if (peer.connectionState === 'disconnected') requestRenegotiation();
          }, 4_000);
        } else if (peer.connectionState === 'failed') {
          requestRenegotiation();
        }
      };

      try {
        await peer.setRemoteDescription(payload.description);
        for (const candidate of candidateQueues.get(payload.epoch) ?? []) {
          await safelyAddIceCandidate(peer, candidate);
        }
        candidateQueues.delete(payload.epoch);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (
          disposed ||
          operation !== currentOperation ||
          peerRef.current !== peer ||
          !peer.localDescription
        ) {
          return;
        }
        socket.emit('webrtc:answer', {
          sessionId,
          epoch: payload.epoch,
          description: peer.localDescription,
        });
        stopStatsRef.current = startStatsCollector(peer, (stats) =>
          statsCallbackRef.current?.(stats),
        );
      } catch {
        if (disposed || operation !== currentOperation) return;
        setConnectionState('failed');
        setError('The phone video could not be attached. Requesting a fresh stream is safe.');
        requestRenegotiation();
      }
    };

    const handleIce = async (payload: {
      sessionId: string;
      epoch: number;
      candidate: RTCIceCandidateInit | null;
    }): Promise<void> => {
      if (payload.sessionId !== sessionId) return;
      const peer = peerRef.current;
      if (!peer || peerEpochRef.current !== payload.epoch || !peer.remoteDescription) {
        const queue = candidateQueues.get(payload.epoch) ?? [];
        queue.push(payload.candidate);
        candidateQueues.set(payload.epoch, queue.slice(-64));
        return;
      }
      await safelyAddIceCandidate(peer, payload.candidate);
    };

    const handleSourceState = (payload: {
      sessionId: string;
      state: BroadcasterSourceState;
    }): void => {
      if (payload.sessionId === sessionId) sourceCallbackRef.current?.(payload.state);
    };

    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:ice', handleIce);
    socket.on('source:state', handleSourceState);

    const requestTimer = broadcasterPresent
      ? setTimeout(() => {
          if (!peerRef.current) requestRenegotiation();
        }, 1_200)
      : undefined;

    setConnectionState(broadcasterPresent ? 'waiting' : 'idle');
    if (!broadcasterPresent) setRemoteStream(null);
    return () => {
      disposed = true;
      operation += 1;
      if (requestTimer) clearTimeout(requestTimer);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:ice', handleIce);
      socket.off('source:state', handleSourceState);
      closePeer();
    };
  }, [broadcasterPresent, joined, requestRenegotiation, rtcConfiguration, sessionId, socket]);

  return { connectionState, remoteStream, error, requestRenegotiation };
};
