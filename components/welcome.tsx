'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { CheckIcon, CopyIcon, HandPointingIcon } from '@phosphor-icons/react';
import { APP_CONFIG_DEFAULTS } from '@/app-config';
import { THEME_STORAGE_KEY, getSandboxId } from '@/lib/env';
import type { ThemeMode } from '@/lib/types';
import { cn } from '@/lib/utils';
import EmbedPopupAgentClient from './embed-popup/agent-client';
import { ThemeToggle } from './theme-toggle';

const EMBED_PARAMS = [
  { name: 'agentId', type: 'string', description: 'Agent ID to connect to' },
  { name: 'theme', type: 'string', description: '"dark" or "light" (default: dark)' },
  { name: 'backgroundColor', type: 'string', description: 'Hex color or "transparent"' },
  { name: 'primaryColor', type: 'string', description: 'Hex color for primary buttons' },
  { name: 'accentColor', type: 'string', description: 'Hex color for accents' },
];

const PLAYGROUND_PARAMS = [
  { name: 'agentId', type: 'string', description: 'Agent ID to connect to (required)' },
  { name: 'name', type: 'string', description: 'Display name for agent in header' },
  { name: 'theme', type: 'string', description: '"dark" or "light" (default: dark)' },
  { name: 'backgroundColor', type: 'string', description: 'Hex color or "transparent"' },
  { name: 'primaryColor', type: 'string', description: 'Hex color for primary buttons' },
  { name: 'accentColor', type: 'string', description: 'Hex color for accents' },
];

type TabType = 'embed' | 'playground' | 'popup';

export default function Welcome() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const selectedTab: TabType =
    tabParam === 'playground' ? 'playground' : tabParam === 'popup' ? 'popup' : 'embed';
  const [, forceUpdate] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const IS_SANDBOX_ENVIRONMENT = process.env.NODE_ENV === 'production';

  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode;
      if (storedTheme) {
        setTheme(storedTheme);
      }
    } catch {
      // localStorage not available
    }
  }, []);

  const [copied, setCopied] = useState(false);
  const copyEmbedCode = useCallback((embedCode: string) => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  }, []);

  const embedSandboxId = useMemo(() => getSandboxId(window.location.origin), []);

  const iframeEmbedUrl = useMemo(() => {
    const url = new URL('/embed', window.location.origin);
    url.searchParams.set('agentId', embedSandboxId);
    url.searchParams.set('theme', theme);
    return url.toString();
  }, [theme, embedSandboxId]);

  const playgroundUrl = useMemo(() => {
    const url = new URL('/playground', window.location.origin);
    url.searchParams.set('agentId', embedSandboxId);
    url.searchParams.set('name', 'Voice Agent');
    url.searchParams.set('theme', theme);
    return url.toString();
  }, [theme, embedSandboxId]);

  const popupEmbedUrl = useMemo(() => {
    const url = new URL('/embed-popup.js', window.location.origin);
    return url.toString();
  }, []);

  const popupEmbedCode = useMemo(
    () => `<script\n  src="${popupEmbedUrl}"\n  data-agent-id="${embedSandboxId}"\n></script>`,
    [popupEmbedUrl, embedSandboxId]
  );

  const iframeEmbedCode = useMemo(() => {
    return `<iframe\n  src="${iframeEmbedUrl}"\n  style="width: 320px; height: 64px;"\n  allow="microphone"\n></iframe>`;
  }, [iframeEmbedUrl]);

  const playgroundEmbedCode = useMemo(() => {
    return `<iframe\n  src="${playgroundUrl}"\n  style="width: 400px; height: 600px;"\n  allow="microphone"\n></iframe>`;
  }, [playgroundUrl]);

  const popupTestUrl = useMemo(() => {
    const url = new URL('/test/popup', window.location.origin);
    return url.toString();
  }, []);

  const handleTabChange = (tab: TabType) => {
    router.push(`${pathname}?tab=${tab}`);
  };

  return (
    <div className="text-fg1 mx-auto flex min-h-screen max-w-2xl flex-col py-4 md:py-10">
      <div className="space-y-8 px-4">
        <div className="flex items-start justify-between">
          <h1 className="text-fg0 text-2xl font-bold">Voice Agent Embed</h1>
          <ThemeToggle className="w-auto" onClick={() => forceUpdate((c) => c + 1)} />
        </div>

        <p className="text-fg2">
          Embed voice agents into any website. Choose from three embed styles below.
        </p>

        {/* Tab selector */}
        <div>
          <div className="border-separator2 rounded-xl border p-1">
            <div className="relative flex gap-1">
              <motion.div
                key="tab-indicator"
                layout="position"
                layoutId="tab-indicator"
                initial={false}
                animate={{
                  left:
                    selectedTab === 'embed'
                      ? '0%'
                      : selectedTab === 'playground'
                        ? '33.33%'
                        : '66.66%',
                }}
                transition={{ duration: 0.3, type: 'spring', bounce: 0 }}
                className="bg-bgAccent/50 dark:bg-bgAccent border-primary/20 dark:border-separatorAccent absolute top-0 h-full w-1/3 rounded-lg border"
              />
              {(['embed', 'playground', 'popup'] as TabType[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => handleTabChange(tab)}
                  className={cn(
                    'text-fg2 focus:text-fgAccent hover:text-fgAccent z-10 flex-1 cursor-pointer py-2 font-mono text-sm capitalize transition-colors',
                    selectedTab === tab && 'text-fgAccent font-bold'
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Embed (iframe bar) */}
        {selectedTab === 'embed' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-fg0 mb-2 font-semibold">Embed Bar</h3>
              <p className="text-fg3 mb-4 text-sm">
                A compact bar widget for quick voice interactions.
              </p>
              <div className="border-separator1 bg-bg2/50 flex justify-center rounded-lg border p-6">
                <iframe
                  src={iframeEmbedUrl}
                  style={{ width: 320, height: 64 }}
                  allow="microphone"
                  className="rounded-full"
                />
              </div>
            </div>

            <div>
              <h4 className="text-fg0 mb-2 text-sm font-semibold">Embed Code</h4>
              <pre className="border-separator2 bg-bg2 scrollbar-custom relative overflow-auto rounded-md border p-3 text-xs">
                <code className="font-mono">{iframeEmbedCode}</code>
                <button
                  onClick={() => copyEmbedCode(iframeEmbedCode)}
                  className="absolute top-2 right-2 cursor-pointer p-1 opacity-50 hover:opacity-100"
                >
                  {copied ? <CheckIcon weight="bold" className="text-fgSuccess" /> : <CopyIcon />}
                </button>
              </pre>
            </div>

            <div>
              <h4 className="text-fg0 mb-2 text-sm font-semibold">URL Parameters</h4>
              <div className="border-separator1 overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-bg2">
                    <tr>
                      <th className="text-fg0 px-3 py-2 text-left font-semibold">Param</th>
                      <th className="text-fg0 px-3 py-2 text-left font-semibold">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {EMBED_PARAMS.map((param) => (
                      <tr key={param.name} className="border-separator1 border-t">
                        <td className="text-fgAccent px-3 py-2 font-mono">{param.name}</td>
                        <td className="text-fg2 px-3 py-2">{param.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Playground */}
        {selectedTab === 'playground' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-fg0 mb-2 font-semibold">Playground</h3>
              <p className="text-fg3 mb-4 text-sm">
                Full-featured interface with transcript, status indicators, and controls.
              </p>
              <div className="flex justify-center">
                <a
                  href={playgroundUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-primary text-primary-foreground hover:bg-primary-hover rounded-full px-6 py-2 text-sm font-semibold transition-colors"
                >
                  Open Playground Demo
                </a>
              </div>
            </div>

            <div>
              <h4 className="text-fg0 mb-2 text-sm font-semibold">Embed Code</h4>
              <pre className="border-separator2 bg-bg2 scrollbar-custom relative overflow-auto rounded-md border p-3 text-xs">
                <code className="font-mono">{playgroundEmbedCode}</code>
                <button
                  onClick={() => copyEmbedCode(playgroundEmbedCode)}
                  className="absolute top-2 right-2 cursor-pointer p-1 opacity-50 hover:opacity-100"
                >
                  {copied ? <CheckIcon weight="bold" className="text-fgSuccess" /> : <CopyIcon />}
                </button>
              </pre>
            </div>

            <div>
              <h4 className="text-fg0 mb-2 text-sm font-semibold">URL Parameters</h4>
              <div className="border-separator1 overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-bg2">
                    <tr>
                      <th className="text-fg0 px-3 py-2 text-left font-semibold">Param</th>
                      <th className="text-fg0 px-3 py-2 text-left font-semibold">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PLAYGROUND_PARAMS.map((param) => (
                      <tr key={param.name} className="border-separator1 border-t">
                        <td className="text-fgAccent px-3 py-2 font-mono">{param.name}</td>
                        <td className="text-fg2 px-3 py-2">{param.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Popup */}
        {selectedTab === 'popup' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-fg0 mb-2 font-semibold">Popup Widget</h3>
              <p className="text-fg3 mb-4 text-sm">
                A floating button that opens a popup conversation window.
              </p>
              <div className="text-fgAccent flex items-center justify-center gap-2">
                <p className="text-sm">Look for the button in the bottom right corner</p>
                <HandPointingIcon
                  size={16}
                  weight="regular"
                  className="rotate-[145deg] animate-bounce"
                />
              </div>
            </div>

            <div>
              <h4 className="text-fg0 mb-2 text-sm font-semibold">Embed Code</h4>
              <pre className="border-separator2 bg-bg2 scrollbar-custom relative overflow-auto rounded-md border p-3 text-xs">
                <code className="font-mono">{popupEmbedCode}</code>
                <button
                  onClick={() => copyEmbedCode(popupEmbedCode)}
                  className="absolute top-2 right-2 cursor-pointer p-1 opacity-50 hover:opacity-100"
                >
                  {copied ? <CheckIcon weight="bold" className="text-fgSuccess" /> : <CopyIcon />}
                </button>
              </pre>
            </div>

            {!IS_SANDBOX_ENVIRONMENT && (
              <div className="text-fg4 text-xs">
                <p>
                  To apply local changes, run{' '}
                  <code className="text-fg0">pnpm build-embed-popup-script</code>.
                </p>
                <p>
                  Test at{' '}
                  <a
                    href={popupTestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {popupTestUrl}
                  </a>
                </p>
              </div>
            )}

            <div>
              <h4 className="text-fg0 mb-2 text-sm font-semibold">Script Attributes</h4>
              <div className="border-separator1 overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-bg2">
                    <tr>
                      <th className="text-fg0 px-3 py-2 text-left font-semibold">Attribute</th>
                      <th className="text-fg0 px-3 py-2 text-left font-semibold">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-separator1 border-t">
                      <td className="text-fgAccent px-3 py-2 font-mono">data-agent-id</td>
                      <td className="text-fg2 px-3 py-2">Agent ID to connect to (required)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <EmbedPopupAgentClient appConfig={APP_CONFIG_DEFAULTS} />
          </div>
        )}
      </div>
    </div>
  );
}
