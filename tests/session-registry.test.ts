import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../server/session-registry';

describe('SessionRegistry', () => {
  afterEach(() => vi.useRealTimers());

  it('tracks control and broadcaster presence independently', () => {
    const registry = new SessionRegistry();
    registry.join('LIVE-ROOM-01', 'control', 'socket-control');
    registry.join('LIVE-ROOM-01', 'broadcaster', 'socket-phone');

    expect(registry.presence('LIVE-ROOM-01').roles).toEqual({
      control: true,
      broadcaster: true,
    });

    registry.leave('socket-phone');
    expect(registry.presence('LIVE-ROOM-01').roles).toEqual({
      control: true,
      broadcaster: false,
    });
  });

  it('replaces an older socket claiming the same session role', () => {
    const registry = new SessionRegistry();
    registry.join('LIVE-ROOM-02', 'control', 'old-control');

    expect(registry.join('LIVE-ROOM-02', 'control', 'new-control')).toEqual({
      replacedSocketId: 'old-control',
    });
    expect(registry.getMembership('old-control')).toBeUndefined();
    expect(registry.getMembership('new-control')).toEqual({
      sessionId: 'LIVE-ROOM-02',
      role: 'control',
    });
  });

  it('moves a socket atomically and expires empty sessions after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    const registry = new SessionRegistry(1000);

    registry.join('LIVE-ROOM-OLD', 'control', 'moving-socket');
    registry.join('LIVE-ROOM-NEW', 'broadcaster', 'moving-socket');

    expect(registry.presence('LIVE-ROOM-OLD').roles.control).toBe(false);
    expect(registry.getMembership('moving-socket')).toEqual({
      sessionId: 'LIVE-ROOM-NEW',
      role: 'broadcaster',
    });

    registry.leave('moving-socket');
    vi.advanceTimersByTime(1001);
    expect(() => registry.prune(Date.now())).not.toThrow();
    const internals = registry as unknown as { sessions: Map<string, unknown> };
    expect(internals.sessions.size).toBe(0);
    expect(registry.presence('LIVE-ROOM-NEW').roles).toEqual({
      control: false,
      broadcaster: false,
    });
  });
});
