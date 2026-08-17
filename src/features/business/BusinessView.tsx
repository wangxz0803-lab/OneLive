import { Icon } from '@/components/Icon';
import { OneLiveMark } from '@/components/OneLiveLogo';

const EQUATION = [
  ['1', '位真人主播'],
  ['1', '台AI直播终端'],
  ['3', '路本地化直播'],
  ['3', '个海外市场'],
  ['1', '套5G + QoD保障'],
];

export function BusinessView() {
  return (
    <main id="main-content" className="business-view" data-testid="business-summary">
      <div className="business-orbit business-orbit--one" />
      <div className="business-orbit business-orbit--two" />

      <section className="business-hero">
        <span className="business-eyebrow">
          <OneLiveMark size={24} />
          真人主源 · 端侧生成 · 三路上行
        </span>
        <h1 lang="zh-CN">
          一个真人，
          <br />
          <em>三个市场同时开播。</em>
        </h1>
        <p>
          OneLive不是用预制数字人替代主播，而是让真人通过AI直播终端实时生成日语、西班牙语和英语三路直播，同时保留真人主导的直播内容。
        </p>
      </section>

      <section className="business-equation" aria-label="OneLive应用场景">
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
          <span>行业痛点与应用场景</span>
          <h2>保留真人可信度，AI只负责多语言扩展</h2>
          <ul>
            <li>预制和循环式数字人容易被识别为非实时内容，平台治理风险更高</li>
            <li>一个中文主播即可同时服务日本、拉美和印度三个直播间</li>
            <li>真人持续主导讲解与互动，AI只负责语言、音色、口型和画面本地化</li>
          </ul>
        </article>
        <article lang="zh-CN">
          <span>网络诉求与商业价值</span>
          <h2>端侧AI把一路内容变成三路上行，也创造新的网络产品</h2>
          <ul>
            <li>端侧AI缩短翻译、音色和口型处理路径，但不会凭空增加带宽</li>
            <li>三路直播共享同一上行，拥塞时需要QoD保障核心直播体验</li>
            <li>运营商可组合AI终端、5G上行、QoD和本地化服务形成新套餐</li>
          </ul>
        </article>
      </section>

      <footer className="business-footer">
        <span>不是让AI替代真人</span>
        <i />
        <span>而是让一个真人进入三个市场</span>
        <i />
        <strong>让网络保障三路实时生意</strong>
      </footer>
    </main>
  );
}
