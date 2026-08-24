import { Icon } from '@/components/Icon';
import { DIRECTOR_PRESETS } from '@/core/director';
import { useOneLiveStore } from '@/store/useOneLiveStore';

export function DirectorHud() {
  const { presenterMode, directorStep, previousDirectorStep, nextDirectorStep, reset } =
    useOneLiveStore();
  if (!presenterMode) return null;
  const step = DIRECTOR_PRESETS[directorStep];
  return (
    <div className="director-hud" data-testid="director-step" data-step={directorStep + 1}>
      <div
        className="director-hud__progress"
        role="progressbar"
        aria-label="演示进度"
        aria-valuemin={1}
        aria-valuemax={DIRECTOR_PRESETS.length}
        aria-valuenow={directorStep + 1}
        aria-valuetext={`${step.label}，第 ${directorStep + 1} 步，共 ${DIRECTOR_PRESETS.length} 步`}
      >
        {DIRECTOR_PRESETS.map((item, index) => (
          <i key={item.id} className={index <= directorStep ? 'active' : ''} aria-hidden="true" />
        ))}
      </div>
      <div className="director-hud__copy" aria-live="polite">
        <span>{step.eyebrow}</span>
        <strong>{step.narrative}</strong>
        <small>{step.nextHint}</small>
      </div>
      <div className="director-hud__controls">
        <button
          type="button"
          onClick={previousDirectorStep}
          disabled={directorStep === 0}
          data-testid="director-previous"
          aria-label="上一步"
        >
          <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button
          type="button"
          onClick={nextDirectorStep}
          disabled={directorStep === DIRECTOR_PRESETS.length - 1}
          data-testid="director-next"
          aria-label="下一步"
        >
          下一步 <Icon name="arrow" />
        </button>
        <button type="button" onClick={reset} aria-label="重置演示">
          <Icon name="reset" />
        </button>
      </div>
    </div>
  );
}
