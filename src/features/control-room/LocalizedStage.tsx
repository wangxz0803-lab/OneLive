import { MARKET_PROFILES } from '@/config/markets';
import type { ExperienceSnapshot } from '@/core/types';
import { MarketCard } from '@/features/control-room/MarketCard';
import { useOneLiveStore } from '@/store/useOneLiveStore';

export function LocalizedStage({ experience }: { experience: ExperienceSnapshot }) {
  const {
    selectedMarketId,
    setSelectedMarket,
    setActiveRecording,
    profileId,
    deployment,
    qod,
    scriptIndex,
  } = useOneLiveStore();
  const market =
    MARKET_PROFILES.find((candidate) => candidate.id === selectedMarketId) ?? MARKET_PROFILES[0];
  const channel =
    experience.channels.find((candidate) => candidate.marketId === market.id) ??
    experience.channels[0];

  const selectMarket = (marketId: (typeof MARKET_PROFILES)[number]['id']) => {
    setSelectedMarket(marketId);
    setActiveRecording('localized');
  };

  return (
    <section
      className="localized-stage panel"
      data-testid="channel-grid"
      aria-label="三地本地化直播输出"
    >
      <header className="localized-stage__header">
        <div>
          <span className="section-kicker">三地直播输出样例</span>
          <strong>点击查看不同市场输出</strong>
        </div>
        <span className="localized-stage__count">3个市场 · 3路直播</span>
      </header>

      <div className="market-tabs" role="tablist" aria-label="选择本地化市场">
        {MARKET_PROFILES.map((candidate) => {
          const selected = candidate.id === market.id;
          const candidateChannel = experience.channels.find(
            (item) => item.marketId === candidate.id,
          );
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              data-testid={`channel-tab-${candidate.id}`}
              data-status={candidateChannel?.status ?? 'paused'}
              data-sync={candidateChannel?.syncWarning ? 'warning' : 'ok'}
              aria-selected={selected}
              aria-controls={`market-panel-${candidate.id}`}
              className={`market-tab market-tab--${candidate.visualTheme} ${selected ? 'market-tab--active' : ''}`}
              onClick={() => selectMarket(candidate.id)}
            >
              <span>0{candidate.priority}</span>
              <strong>{candidate.market}</strong>
              <small>{candidate.language}</small>
              <i
                data-status={candidateChannel?.status ?? 'paused'}
                data-sync={candidateChannel?.syncWarning ? 'warning' : 'ok'}
              />
            </button>
          );
        })}
      </div>

      <div id={`market-panel-${market.id}`} role="tabpanel" aria-label={`${market.market}版本`}>
        <MarketCard
          market={market}
          channel={channel}
          profileId={profileId}
          deployment={deployment}
          qod={qod}
          scriptIndex={scriptIndex}
        />
      </div>
    </section>
  );
}
