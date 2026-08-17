import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseCss = readFileSync('src/styles/index.css', 'utf8');
const demoCss = readFileSync('src/styles/four-video-demo.css', 'utf8');

describe('leadership visual system', () => {
  it('separates interface typography from data typography', () => {
    expect(baseCss).toContain('--font-ui:');
    expect(baseCss).toContain('--font-data:');
    expect(demoCss).toMatch(/\.source-telemetry strong\s*\{[^}]*var\(--font-data\)/s);
    expect(demoCss).toMatch(/\.source-telemetry span,[^}]*var\(--font-ui\)/s);
  });

  it('removes the generic highlight layer from top-level panels', () => {
    expect(baseCss).toMatch(/\.panel::after\s*\{[^}]*display:\s*none/s);
  });
});
