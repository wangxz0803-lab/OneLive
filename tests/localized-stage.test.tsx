import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveExperience } from '@/core/network';
import { LocalizedStage } from '@/features/control-room/LocalizedStage';
import { useOneLiveStore } from '@/store/useOneLiveStore';

describe('localized market stage', () => {
  beforeEach(() => {
    useOneLiveStore.getState().reset();
  });

  it('renders three market tabs and only the selected localized video', () => {
    const experience = deriveExperience({
      profileId: 'premium',
      deployment: 'cloud',
      qod: false,
    });

    render(<LocalizedStage experience={experience} />);

    expect(screen.getByText('三地直播输出样例')).toBeInTheDocument();
    expect(screen.getByText('点击查看不同市场输出')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /日本.*日语/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /拉美.*西班牙语/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /印度.*英语/i })).toBeInTheDocument();
    expect(screen.getByTestId('channel-card-japan')).toBeInTheDocument();
    expect(screen.queryByText('AI 生成 · 已授权')).not.toBeInTheDocument();
    expect(screen.getByText('ja-JP')).toBeInTheDocument();
    expect(screen.getByText('已保障')).toBeInTheDocument();
    expect(screen.getByText(/本地化文案/)).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
    expect(screen.getByText('3个市场 · 3路直播')).toBeInTheDocument();
    expect(screen.queryByText(/03 个市场 · 模拟 EMULATED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/模拟 EMULATED/)).not.toBeInTheDocument();
    expect(screen.getByTestId('channel-card-japan')).toHaveAttribute('data-provenance', 'EMULATED');
    expect(screen.queryByTestId('channel-card-latam')).not.toBeInTheDocument();
    expect(screen.getByTestId('localized-video')).toHaveAttribute(
      'src',
      '/demo-media/japan-ja.mp4',
    );
  });

  it('switches the visible video and active recording when a market tab is clicked', () => {
    const experience = deriveExperience({
      profileId: 'premium',
      deployment: 'cloud',
      qod: false,
    });

    render(<LocalizedStage experience={experience} />);
    fireEvent.click(screen.getByRole('tab', { name: /拉美.*西班牙语/i }));

    expect(useOneLiveStore.getState()).toMatchObject({
      selectedMarketId: 'latam',
      activeRecording: 'localized',
    });
    expect(screen.getByTestId('channel-card-latam')).toBeInTheDocument();
    expect(screen.getByTestId('localized-video')).toHaveAttribute(
      'src',
      '/demo-media/latam-es.mp4',
    );
  });

  it('exposes an audible cloud-latency offset for the selected localized video', () => {
    useOneLiveStore.getState().applyDirectorStep(2);
    const experience = deriveExperience({
      profileId: 'latency',
      deployment: 'cloud',
      qod: false,
    });

    render(<LocalizedStage experience={experience} />);

    expect(screen.getByTestId('localized-video')).toHaveAttribute('data-audio-delay-ms', '1000');
  });
});
