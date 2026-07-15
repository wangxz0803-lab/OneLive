export type PeerRole = 'control' | 'broadcaster';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RuntimeConfig {
  mode: 'live' | 'mock';
  secure: boolean;
  sessionId: string;
  socketPath: string;
  iceServers: IceServerConfig[];
  translation: {
    available: boolean;
    model?: string;
  };
  paths: {
    control: string;
    broadcaster: string;
  };
}

export interface SessionJoinRequest {
  sessionId: string;
  role: PeerRole;
  clientId: string;
}

export interface SessionPresence {
  sessionId: string;
  roles: Record<PeerRole, boolean>;
  updatedAt: number;
}

export type SessionJoinAck =
  | { ok: true; presence: SessionPresence }
  | { ok: false; error: string };

export interface SessionDescriptionEnvelope {
  sessionId: string;
  epoch: number;
  description: RTCSessionDescriptionInit;
}

export interface IceCandidateEnvelope {
  sessionId: string;
  epoch: number;
  candidate: RTCIceCandidateInit | null;
}

export interface SenderConstraints {
  maxBitrateBps: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

export interface BroadcasterSourceState {
  connection: 'idle' | 'requesting-media' | 'ready' | 'streaming' | 'reconnecting' | 'failed';
  audioEnabled: boolean;
  videoEnabled: boolean;
  facingMode: 'user' | 'environment' | 'unknown';
  updatedAt: number;
}

export interface SourceStateEnvelope {
  sessionId: string;
  state: BroadcasterSourceState;
}

export type SourceCommand =
  | { type: 'set-sender-constraints'; constraints: SenderConstraints }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'switch-camera' }
  | { type: 'request-keyframe' }
  | { type: 'renegotiate' };

export interface SourceCommandEnvelope {
  sessionId: string;
  command: SourceCommand;
}

export interface ServerErrorMessage {
  code: 'INVALID_MESSAGE' | 'NOT_JOINED' | 'WRONG_ROLE' | 'SESSION_REPLACED';
  message: string;
}

export interface ClientToServerEvents {
  'session:join': (
    payload: SessionJoinRequest,
    acknowledge?: (result: SessionJoinAck) => void,
  ) => void;
  'webrtc:offer': (payload: SessionDescriptionEnvelope) => void;
  'webrtc:answer': (payload: SessionDescriptionEnvelope) => void;
  'webrtc:ice': (payload: IceCandidateEnvelope) => void;
  'source:state': (payload: SourceStateEnvelope) => void;
  'source:command': (payload: SourceCommandEnvelope) => void;
}

export interface ServerToClientEvents {
  'session:presence': (presence: SessionPresence) => void;
  'session:replaced': (message: ServerErrorMessage) => void;
  'server:error': (message: ServerErrorMessage) => void;
  'webrtc:offer': (payload: SessionDescriptionEnvelope) => void;
  'webrtc:answer': (payload: SessionDescriptionEnvelope) => void;
  'webrtc:ice': (payload: IceCandidateEnvelope) => void;
  'source:state': (payload: SourceStateEnvelope) => void;
  'source:command': (payload: SourceCommandEnvelope) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  sessionId?: string;
  role?: PeerRole;
  clientId?: string;
}

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

