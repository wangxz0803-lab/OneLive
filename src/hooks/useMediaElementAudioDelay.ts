import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  createMediaElementAudioDelay,
  type MediaElementAudioDelayController,
} from '@/media/mediaElementAudioDelay';

export function useMediaElementAudioDelay(
  mediaRef: RefObject<HTMLVideoElement | null>,
  delayMs: number,
): () => Promise<void> {
  const controllerRef = useRef<MediaElementAudioDelayController | null>(null);
  const elementRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    controllerRef.current?.setDelay(delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      elementRef.current = null;
    },
    [],
  );

  return useCallback(async () => {
    const element = mediaRef.current;
    if (!element) return;

    if (elementRef.current !== element) {
      controllerRef.current?.dispose();
      const controller = createMediaElementAudioDelay(element, delayMs);
      controllerRef.current = controller;
      elementRef.current = controller ? element : null;
    }

    await controllerRef.current?.resume().catch(() => undefined);
  }, [delayMs, mediaRef]);
}
