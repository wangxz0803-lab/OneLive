import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveExperience } from '@/core/network';
import { AvatarTechnologyStage } from '@/features/control-room/AvatarTechnologyStage';
import { NetworkDrawer } from '@/features/control-room/NetworkDrawer';
import { useOneLiveStore } from '@/store/useOneLiveStore';

vi.mock('@/features/avatars/AvatarStage', () => ({
  AvatarStage: ({ market }: { market: { id: string; language: string } }) => (
    <div data-testid={`avatar-stage-${market.id}`}>{market.language}数字人</div>
  ),
}));

describe('avatar technology view', () => {
  beforeEach(() => {
    useOneLiveStore.getState().reset();
  });

  it('keeps all three regional avatar previews available as an emulated technology view', () => {
    const experience = deriveExperience({
      profileId: 'premium',
      deployment: 'cloud',
      qod: false,
    });

    render(<AvatarTechnologyStage experience={experience} />);

    expect(screen.getByTestId('avatar-technology-stage')).toHaveAttribute(
      'data-provenance',
      'EMULATED',
    );
    expect(screen.getByText('数字人技术视图')).toBeInTheDocument();
    expect(screen.getByText(/程序化人脸、口型与姿态/)).toBeInTheDocument();

    for (const marketId of ['japan', 'latam', 'india']) {
      expect(screen.getByTestId(`avatar-channel-${marketId}`)).toHaveAttribute(
        'data-provenance',
        'EMULATED',
      );
      expect(screen.getByTestId(`avatar-stage-${marketId}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('localized-video')).not.toBeInTheDocument();
  });

  it('switches from the drawer and returns to the video path when the director starts', () => {
    useOneLiveStore.getState().setDrawerOpen(true);
    render(<NetworkDrawer />);

    fireEvent.click(screen.getByTestId('stage-mode-avatar'));
    expect(useOneLiveStore.getState()).toMatchObject({
      view: 'control',
      controlStageMode: 'avatar',
      drawerOpen: false,
    });

    act(() => useOneLiveStore.getState().applyDirectorStep(1));
    expect(useOneLiveStore.getState()).toMatchObject({
      view: 'control',
      controlStageMode: 'video',
    });
  });
});
