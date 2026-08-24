import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessView } from '@/features/business/BusinessView';
import { ComparisonView } from '@/features/comparison/ComparisonView';
import { useOneLiveStore } from '@/store/useOneLiveStore';

describe('comparison and business close', () => {
  beforeEach(() => {
    useOneLiveStore.getState().reset();
  });

  it('compares the currently selected localized video without mounting WebGL canvas', () => {
    useOneLiveStore.getState().setSelectedMarket('latam');
    const { container } = render(<ComparisonView />);

    expect(screen.getAllByTestId('comparison-video')).toHaveLength(2);
    for (const video of screen.getAllByTestId('comparison-video')) {
      expect(video).toHaveAttribute('src', '/demo-media/latam-es.mp4');
    }
    expect(screen.getByText('同一市场视频，不同网络体验')).toBeInTheDocument();
    expect(screen.getByText('云端处理 · 普通网络')).toBeInTheDocument();
    expect(screen.getByText('边缘 AI · QoD 保障')).toBeInTheDocument();
    expect(screen.getByText('边缘保障后')).toBeInTheDocument();
    expect(screen.getByText('核心体验恢复')).toBeInTheDocument();
    expect(screen.getAllByTestId('comparison-delta')).toHaveLength(3);
    expect(screen.queryByText('AI 生成 · 已授权')).not.toBeInTheDocument();
    expect(screen.getAllByText('拉美 · es-MX')).toHaveLength(2);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('closes on one real host, an AI terminal and three localized live outputs', () => {
    render(<BusinessView />);

    expect(screen.getByLabelText('OneLive应用场景')).toHaveTextContent('1台AI直播终端');
    expect(screen.getByText(/一个真人，/)).toBeInTheDocument();
    expect(screen.getByText('三个市场同时开播。')).toBeInTheDocument();
    expect(screen.getByText('保留真人可信度，AI只负责多语言扩展')).toBeInTheDocument();
    expect(
      screen.getByText('端侧AI把一路内容变成三路上行，也创造新的网络产品'),
    ).toBeInTheDocument();
  });
});
