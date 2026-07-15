import { Icon } from '@/components/Icon';
import { OneLiveMark } from '@/components/OneLiveLogo';

const EQUATION = [
  ['1', '真人主播'],
  ['3', '种语言'],
  ['3', '数字分身'],
  ['3', '直播市场'],
  ['1', '次内容生产'],
];

export function BusinessView() {
  return (
    <main id="main-content" className="business-view" data-testid="business-summary">
      <div className="business-orbit business-orbit--one" />
      <div className="business-orbit business-orbit--two" />
      <section className="business-hero">
        <span className="business-eyebrow">
          <OneLiveMark size={24} />
          ONE SOURCE. MANY MARKETS. LIVE.
        </span>
        <h1 lang="zh-CN">
          一次直播，
          <br />
          <em>多市场同时开播。</em>
        </h1>
        <p>
          One human performance becomes three locally relevant live experiences — synchronized by
          5G, Edge AI and assured network capability.
        </p>
      </section>
      <section className="business-equation" aria-label="OneLive commercial outcome">
        {EQUATION.map(([number, label], index) => (
          <div key={label} className="equation-item">
            <span>
              <strong>{number}</strong>
              <small lang="zh-CN">{label}</small>
            </span>
            {index < EQUATION.length - 1 && <Icon name="arrow" size={20} />}
          </div>
        ))}
      </section>
      <section className="business-value">
        <article lang="zh-CN">
          <span>FOR GLOBAL COMMERCE</span>
          <h2>一次采集，多语本地化，同步分发</h2>
          <ul>
            <li>减少重复开播与多语主播组织复杂度</li>
            <li>让跨境内容更快进入目标市场</li>
            <li>让中小商家拥有本地化直播能力</li>
          </ul>
        </article>
        <article lang="zh-CN">
          <span>FOR NETWORK OPERATORS</span>
          <h2>从连接到可保障的实时体验</h2>
          <ul>
            <li>蜂窝视频上行与多频道下行</li>
            <li>边缘 AI 推理和会话级编排</li>
            <li>QoD 网络保障成为体验差异化能力</li>
          </ul>
        </article>
      </section>
      <footer className="business-footer">
        <span>ONE LIVE SESSION</span>
        <i />
        <span>THREE LOCAL EXPERIENCES</span>
        <i />
        <strong>BUILT ON THE NETWORK</strong>
      </footer>
    </main>
  );
}
