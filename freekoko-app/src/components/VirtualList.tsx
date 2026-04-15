import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from 'react';

/**
 * CSS-only virtualization for fixed-height rows.
 *
 * Renders a scrollable container that only mounts items inside the
 * visible window (plus an overscan buffer on each side). Each rendered
 * row is absolutely positioned via `transform: translateY(...)` so the
 * browser does not need to lay out rows that aren't currently visible.
 *
 * Intended for the Logs view (1000+ entries) — we avoid a third-party
 * virtualization dependency and keep the implementation intentionally
 * minimal. See `/.planning/ARCHITECTURE.md` §4.3.
 */
export interface VirtualListHandle {
  scrollToBottom: () => void;
  scrollToIndex: (index: number) => void;
  isAtBottom: (tolerancePx?: number) => boolean;
  getScrollElement: () => HTMLDivElement | null;
}

export interface VirtualListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  itemHeight: number;
  overscan?: number;
  className?: string;
  style?: CSSProperties;
  onScroll?: (evt: UIEvent<HTMLDivElement>) => void;
  ariaLabel?: string;
  role?: string;
  ariaLive?: 'off' | 'polite' | 'assertive';
}

function VirtualListInner<T>(
  props: VirtualListProps<T>,
  ref: React.Ref<VirtualListHandle>
) {
  const {
    items,
    renderItem,
    itemHeight,
    overscan = 10,
    className,
    style,
    onScroll,
    ariaLabel,
    role,
    ariaLive,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: () => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      },
      scrollToIndex: (index: number) => {
        const el = containerRef.current;
        if (!el) return;
        el.scrollTop = Math.max(0, index * itemHeight);
      },
      isAtBottom: (tolerancePx = 40) => {
        const el = containerRef.current;
        if (!el) return true;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - tolerancePx;
      },
      getScrollElement: () => containerRef.current,
    }),
    [itemHeight]
  );

  const totalHeight = items.length * itemHeight;
  const { startIdx, endIdx } = useMemo(() => {
    const visible = Math.ceil(viewportHeight / itemHeight) || 1;
    const rawStart = Math.floor(scrollTop / itemHeight) - overscan;
    const start = Math.max(0, rawStart);
    const end = Math.min(items.length, start + visible + overscan * 2);
    return { startIdx: start, endIdx: end };
  }, [scrollTop, viewportHeight, itemHeight, overscan, items.length]);

  const visibleItems = items.slice(startIdx, endIdx);

  const handleScroll = (evt: UIEvent<HTMLDivElement>) => {
    setScrollTop(evt.currentTarget.scrollTop);
    onScroll?.(evt);
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        overflowY: 'auto',
        height: '100%',
        ...style,
      }}
      onScroll={handleScroll}
      role={role}
      aria-label={ariaLabel}
      aria-live={ariaLive}
      data-testid="virtual-list"
    >
      <div
        style={{
          position: 'relative',
          height: totalHeight,
          width: '100%',
        }}
      >
        {visibleItems.map((item, i) => {
          const index = startIdx + i;
          return (
            <div
              key={index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: itemHeight,
                transform: `translateY(${index * itemHeight}px)`,
              }}
              data-testid="virtual-list-row"
              data-index={index}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: React.Ref<VirtualListHandle> }
) => ReturnType<typeof VirtualListInner>;
