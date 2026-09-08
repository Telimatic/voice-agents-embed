'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';
import { getSandboxId } from '@/lib/env';
import './styles.css';

// Used when the page is loaded without an `?agentId=` query param.
const DEV_AGENT_ID = 'a745f083-ea18-4aeb-89a0-ac264e826a71';

const CODE_SNIPPET = `
function toggleTheme() {
  var embedWrapper = document.querySelector('#voice-agent-embed-wrapper');

  if (embedWrapper) {
    embedWrapper.classList.toggle('dark');
  }
}
`.trim();

export default function Page() {
  const [sandboxId, setSandboxId] = useState('');
  const [agentId, setAgentId] = useState('');

  useEffect(() => {
    setSandboxId(getSandboxId(window.location.origin));
    const params = new URLSearchParams(window.location.search);
    setAgentId(params.get('agentId') || DEV_AGENT_ID);
  }, []);

  function handleToggleTheme() {
    const doc = document.documentElement;
    const popupWrapper = document.querySelector('#voice-agent-embed-wrapper');

    doc.classList.toggle('page-dark');

    if (popupWrapper) {
      popupWrapper.classList.toggle('dark');
    }
  }

  return (
    <div>
      <p>This page has a minimal stylesheet inorder to test the embed-popup.js bundled styles</p>
      <p>
        Ensure you have run <code>pnpm build-embed-popup-script</code> after your latest code
        changes.
      </p>
      <p>
        In order to toggle the theme on the popup, <br />
        apply the class `dark` to the root element (#voice-agent-embed-wrapper)
      </p>

      <pre>
        <code>{CODE_SNIPPET}</code>
      </pre>

      <p>
        <button onClick={handleToggleTheme}>toggle theme</button>
      </p>
      {agentId && (
        <Script src="/embed-popup.js" data-agent-id={agentId} data-lk-sandbox-id={sandboxId} />
      )}
    </div>
  );
}
