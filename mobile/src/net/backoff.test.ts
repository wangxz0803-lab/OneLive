// 指数退避 + full jitter：delay = round(rng() * min(cap, base*factor^attempt))。
// rng 注入（默认 Math.random），使 jitter 可确定性单测。
import { backoffDelay } from "./backoff";

describe("backoffDelay full-jitter envelope", () => {
  it("attempt 0 scales the base by rng (base 500)", () => {
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(0, () => 0)).toBe(0);
    expect(backoffDelay(0, () => 0.5)).toBe(250);
  });

  it("doubles the ceiling each attempt up to the cap", () => {
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(2, () => 1)).toBe(2000);
    expect(backoffDelay(3, () => 1)).toBe(4000);
    expect(backoffDelay(4, () => 1)).toBe(8000);
  });

  it("clamps at capMs for large attempts without overflow", () => {
    expect(backoffDelay(5, () => 1)).toBe(8000);
    expect(backoffDelay(50, () => 1)).toBe(8000);
    expect(backoffDelay(50, () => 0.5)).toBe(4000);
  });

  it("honours custom base/factor/cap options", () => {
    expect(backoffDelay(1, () => 1, { baseMs: 100, factor: 3, capMs: 5000 })).toBe(300);
    expect(backoffDelay(10, () => 1, { baseMs: 100, factor: 3, capMs: 5000 })).toBe(5000);
  });
});
