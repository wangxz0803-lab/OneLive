import { useEffect, useRef, useState } from 'react';

export function useEmulatedDelay<T>(value: T, delayMs: number): { value: T; pending: boolean } {
  const [delivered, setDelivered] = useState(value);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const current = generation.current;
    setPending(true);
    const timeout = window.setTimeout(() => {
      if (generation.current === current) {
        setDelivered(value);
        setPending(false);
      }
    }, Math.max(0, Math.min(1600, delayMs)));
    return () => window.clearTimeout(timeout);
  }, [value, delayMs]);

  return { value: delivered, pending };
}
