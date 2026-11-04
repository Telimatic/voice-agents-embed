'use client';

import { useRoomContext } from '@livekit/components-react';
import { Button } from '@/components/ui/button';
import { type PanelHighlight, useDisplayPanel } from '@/hooks/use-display-panel';
import type { DisplayPushPayload } from '@/lib/screenshare-protocol';
import { cn } from '@/lib/utils';

/** Agent-supplied pages may run scripts and forms but cannot navigate the host page. */
export const PANEL_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups';

function NewTabLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-fgAccent text-xs underline focus-visible:outline-2"
    >
      Open in new tab
    </a>
  );
}

function Body({
  item,
  highlight,
  onPay,
}: {
  item: DisplayPushPayload;
  highlight: PanelHighlight | null;
  onPay: () => void;
}) {
  const url = item.url ?? '';
  switch (item.kind) {
    case 'url':
    case 'pdf':
      return (
        <>
          <iframe
            src={url}
            title={item.title}
            sandbox={PANEL_IFRAME_SANDBOX}
            className="bg-bg1 min-h-0 w-full flex-1 rounded-lg border-0"
          />
          <NewTabLink url={url} />
        </>
      );
    case 'image': {
      const r = highlight?.region;
      return (
        <div className="min-h-0 w-full flex-1 overflow-auto">
          <div className="relative inline-block max-w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={item.title} className="block max-w-full rounded-lg" />
            {r && (
              <div
                data-testid="display-region-highlight"
                className="border-fgAccent pointer-events-none absolute rounded-sm border-2"
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
              />
            )}
          </div>
        </div>
      );
    }
    case 'steps':
      return (
        <ol className="text-fg1 min-h-0 flex-1 list-decimal space-y-1 overflow-auto pl-5 text-sm">
          {(item.steps ?? []).map((step, i) => (
            <li
              key={i}
              aria-current={highlight?.step === i ? 'step' : undefined}
              data-highlighted={highlight?.step === i ? 'true' : undefined}
              className={cn('rounded px-1', highlight?.step === i && 'bg-bgAccent font-semibold')}
            >
              {step}
            </li>
          ))}
        </ol>
      );
    case 'payment':
      return (
        <div className="bg-bg2 border-separator1 flex flex-col items-start gap-3 rounded-2xl border p-4">
          {item.amount_label && (
            <p className="text-fg1 text-lg font-semibold">{item.amount_label}</p>
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onPay}
            className="bg-primary text-primary-foreground rounded-full px-4 py-2 text-sm font-semibold focus-visible:outline-2"
          >
            Pay now
          </a>
        </div>
      );
  }
}

/** TLZ-561 (C1-C4). The caller can close, minimize and reopen what the agent pushes. */
export function ContentPanel({ className }: { className?: string }) {
  const room = useRoomContext();
  const { item, highlight, mode, last, close, minimize, reopen, paymentOpened } =
    useDisplayPanel(room);

  if (item && mode === 'open') {
    return (
      <section
        role="dialog"
        aria-label={item.title || 'Shared content'}
        data-testid="display-panel"
        className={cn(
          'bg-background border-separator1 dark:border-separator2 absolute inset-x-2 bottom-16 z-20 flex max-h-[70%] flex-col gap-2 rounded-2xl border p-3 drop-shadow-lg',
          className
        )}
      >
        <header className="flex items-center gap-2">
          <h2 className="text-fg1 min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</h2>
          <Button type="button" size="sm" variant="ghost" onClick={minimize}>
            Minimize
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={close}>
            Close
          </Button>
        </header>
        <Body item={item} highlight={highlight} onPay={paymentOpened} />
      </section>
    );
  }

  if (!(item ?? last)) return null;
  return (
    <div
      role="region"
      aria-label="Shared content"
      className={cn('absolute bottom-16 left-2 z-20', className)}
    >
      <Button type="button" size="sm" variant="secondary" onClick={reopen}>
        Reopen last
      </Button>
    </div>
  );
}
