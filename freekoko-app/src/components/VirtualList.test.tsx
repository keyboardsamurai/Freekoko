// @vitest-environment happy-dom
import { afterEach, describe, expect, it, beforeAll } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { VirtualList } from './VirtualList';

// happy-dom does not implement ResizeObserver; stub it so the component's
// effect-driven height measurement short-circuits gracefully.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function patchViewportHeight(el: HTMLElement, height: number) {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

afterEach(() => cleanup());

describe('VirtualList', () => {
  it('renders only a slice of items for a very large list', () => {
    const items = Array.from({ length: 10000 }, (_, i) => i);
    const { container, rerender } = render(
      <VirtualList
        items={items}
        itemHeight={20}
        overscan={5}
        renderItem={(n) => <span>item-{n}</span>}
      />
    );

    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    expect(list).toBeTruthy();
    // Stub viewport height so the next render's effect math uses 500px.
    patchViewportHeight(list, 500);

    // Force a re-measure by triggering a scroll event (also re-runs render
    // with updated scrollTop=0) — then rerender to flush the resize-
    // derived state.
    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });
    rerender(
      <VirtualList
        items={items}
        itemHeight={20}
        overscan={5}
        renderItem={(n) => <span>item-{n}</span>}
      />
    );

    // Expected visible rows: 500/20 = 25 + overscan*2 = 35 (first page
    // has no leading overscan because start is clamped to 0).
    const rows = container.querySelectorAll('[data-testid="virtual-list-row"]');
    expect(rows.length).toBeLessThan(100);
    expect(rows.length).toBeGreaterThan(0);
    // Much smaller than the total 10000 items.
    expect(rows.length).toBeLessThan(items.length);
  });

  it('updates visible window when scrolled', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const { container } = render(
      <VirtualList
        items={items}
        itemHeight={20}
        overscan={5}
        renderItem={(n) => <span>item-{n}</span>}
      />
    );

    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    patchViewportHeight(list, 400);
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 2000 });

    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });

    const rows = Array.from(
      container.querySelectorAll('[data-testid="virtual-list-row"]')
    );
    const indices = rows.map((r) => Number(r.getAttribute('data-index')));
    expect(indices.length).toBeGreaterThan(0);
    // scrollTop 2000 / itemHeight 20 = row 100 — expect indices in the
    // 95..125 range after overscan.
    const min = Math.min(...indices);
    const max = Math.max(...indices);
    expect(min).toBeGreaterThanOrEqual(90);
    expect(max).toBeGreaterThanOrEqual(100);
  });

  it('produces the correct total-height spacer for the scrollbar', () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    const { container } = render(
      <VirtualList
        items={items}
        itemHeight={20}
        renderItem={(n) => <span>i-{n}</span>}
      />
    );
    const list = container.querySelector('[data-testid="virtual-list"]') as HTMLElement;
    const spacer = list.firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe('10000px');
  });
});
