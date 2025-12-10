'use client';

import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { THEME_MEDIA_QUERY, THEME_STORAGE_KEY } from '@/lib/env';
import type { ThemeMode } from '@/lib/types';
import { cn } from '@/lib/utils';

const THEME_SCRIPT = `
  (function() {
    var doc = document.documentElement;
    var params = new URLSearchParams(window.location.search);

    // URL params override localStorage
    var urlTheme = params.get('theme');
    var theme = urlTheme || localStorage.getItem("${THEME_STORAGE_KEY}") || "system";

    var backgroundColor = params.get('backgroundColor');
    var primaryColor = params.get('primaryColor');
    var accentColor = params.get('accentColor');

    // Apply theme class (light, dark, or system)
    if (theme === "system") {
      if (window.matchMedia("${THEME_MEDIA_QUERY}").matches) {
        doc.classList.add("dark");
      } else {
        doc.classList.add("light");
      }
    } else {
      doc.classList.add(theme);
    }

    // Apply custom backgroundColor if provided
    if (backgroundColor) {
      if (backgroundColor === 'transparent') {
        doc.style.setProperty('--background', 'transparent');
        doc.style.setProperty('--embed-bg', 'transparent');
      } else {
        var color = backgroundColor.charAt(0) === '#' ? backgroundColor : '#' + backgroundColor;
        doc.style.setProperty('--background', color);
        doc.style.setProperty('--embed-bg', color);
      }
    }

    // Apply custom primaryColor if provided
    if (primaryColor) {
      var pColor = primaryColor.charAt(0) === '#' ? primaryColor : '#' + primaryColor;
      doc.style.setProperty('--primary', pColor);
      doc.style.setProperty('--primary-hover', pColor);
    }

    // Apply custom accentColor if provided
    if (accentColor) {
      var aColor = accentColor.charAt(0) === '#' ? accentColor : '#' + accentColor;
      doc.style.setProperty('--accent', aColor);
      doc.style.setProperty('--fgAccent', aColor);
    }
  })();
`;

function applyTheme(theme: ThemeMode) {
  const doc = document.documentElement;

  doc.classList.remove('dark', 'light');
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  if (theme === 'system') {
    if (window.matchMedia(THEME_MEDIA_QUERY).matches) {
      doc.classList.add('dark');
    } else {
      doc.classList.add('light');
    }
  } else {
    doc.classList.add(theme);
  }
}

export function ApplyThemeScript() {
  return <script id="theme-script" dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}

interface ThemeToggleProps {
  className?: string;
  onClick?: () => void;
}

export function ThemeToggle({ className, onClick = () => {} }: ThemeToggleProps) {
  const [theme, setTheme] = useState<ThemeMode | undefined>(undefined);

  useEffect(() => {
    const storedTheme = (localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode) ?? 'system';

    setTheme(storedTheme);
  }, []);

  function handleThemeChange(theme: ThemeMode) {
    applyTheme(theme);
    setTheme(theme);
    onClick();
  }

  return (
    <div
      className={cn(
        'text-foreground bg-background flex w-full flex-row justify-end divide-x overflow-hidden rounded-full border',
        className
      )}
    >
      <span className="sr-only">Color scheme toggle</span>
      <button
        type="button"
        onClick={() => handleThemeChange('dark')}
        className="cursor-pointer p-1 pl-1.5"
      >
        <span className="sr-only">Enable dark color scheme</span>
        <MoonIcon size={16} weight="bold" className={cn(theme !== 'dark' && 'opacity-25')} />
      </button>
      <button
        type="button"
        onClick={() => handleThemeChange('light')}
        className="cursor-pointer px-1.5 py-1"
      >
        <span className="sr-only">Enable light color scheme</span>
        <SunIcon size={16} weight="bold" className={cn(theme !== 'light' && 'opacity-25')} />
      </button>
      <button
        type="button"
        onClick={() => handleThemeChange('system')}
        className="cursor-pointer p-1 pr-1.5"
      >
        <span className="sr-only">Enable system color scheme</span>
        <MonitorIcon size={16} weight="bold" className={cn(theme !== 'system' && 'opacity-25')} />
      </button>
    </div>
  );
}
