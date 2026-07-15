import type { PeerRole, SessionPresence } from '../src/realtime/protocol';

interface SessionRecord {
  peers: Partial<Record<PeerRole, string>>;
  updatedAt: number;
  expiresAt: number;
}

interface Membership {
  sessionId: string;
  role: PeerRole;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly memberships = new Map<string, Membership>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  join(sessionId: string, role: PeerRole, socketId: string): { replacedSocketId?: string } {
    this.leave(socketId);

    const now = Date.now();
    const session = this.sessions.get(sessionId) ?? {
      peers: {},
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
    const replacedSocketId = session.peers[role];

    if (replacedSocketId && replacedSocketId !== socketId) {
      this.memberships.delete(replacedSocketId);
    }

    session.peers[role] = socketId;
    session.updatedAt = now;
    session.expiresAt = now + this.ttlMs;
    this.sessions.set(sessionId, session);
    this.memberships.set(socketId, { sessionId, role });

    return replacedSocketId && replacedSocketId !== socketId ? { replacedSocketId } : {};
  }

  leave(socketId: string): Membership | undefined {
    const membership = this.memberships.get(socketId);
    if (!membership) return undefined;

    this.memberships.delete(socketId);
    const session = this.sessions.get(membership.sessionId);
    if (!session) return membership;

    if (session.peers[membership.role] === socketId) {
      delete session.peers[membership.role];
    }
    session.updatedAt = Date.now();
    session.expiresAt = session.updatedAt + this.ttlMs;
    return membership;
  }

  getMembership(socketId: string): Membership | undefined {
    return this.memberships.get(socketId);
  }

  presence(sessionId: string): SessionPresence {
    const session = this.sessions.get(sessionId);
    return {
      sessionId,
      roles: {
        control: Boolean(session?.peers.control),
        broadcaster: Boolean(session?.peers.broadcaster),
      },
      updatedAt: session?.updatedAt ?? Date.now(),
    };
  }

  prune(now = Date.now()): void {
    for (const [sessionId, session] of this.sessions) {
      const hasPeers = Boolean(session.peers.control || session.peers.broadcaster);
      if (!hasPeers && session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

