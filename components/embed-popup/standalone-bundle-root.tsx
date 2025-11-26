import * as React from 'react';
import ReactDOM from 'react-dom/client';
import { getAppConfig } from '@/lib/env';
import globalCss from '@/styles/globals.css';
import EmbedFixedAgentClient from './agent-client';

// Support both data-agent-id (voice-agents) and data-lk-sandbox-id (LiveKit sandbox)
const scriptTag = document.querySelector<HTMLScriptElement>(
  'script[data-agent-id], script[data-lk-sandbox-id]'
);
const agentIdAttribute = scriptTag?.dataset.agentId || scriptTag?.dataset.lkSandboxId;

// Derive the API base URL from the script's src attribute
const getScriptOrigin = (): string => {
  if (scriptTag?.src) {
    try {
      const url = new URL(scriptTag.src);
      return url.origin;
    } catch {
      return window.location.origin;
    }
  }
  return window.location.origin;
};

const scriptOrigin = getScriptOrigin();

if (agentIdAttribute) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('id', 'voice-agent-embed-wrapper');
  document.body.appendChild(wrapper);

  // Use a shadow root so that any relevant css classes don't leak out and effect the broader page
  const shadowRoot = wrapper.attachShadow({ mode: 'open' });

  // Include all app styles into the shadow root
  const styleTag = document.createElement('style');
  styleTag.textContent = globalCss;
  shadowRoot.appendChild(styleTag);

  const reactRoot = document.createElement('div');
  shadowRoot.appendChild(reactRoot);

  getAppConfig(scriptOrigin, agentIdAttribute)
    .then((appConfig) => {
      // Pass the agentId to appConfig for use in connection details
      appConfig.agentId = agentIdAttribute;
      // Set the connection details endpoint based on script origin
      appConfig.connectionDetailsEndpoint = `${scriptOrigin}/api/connection-details`;
      const root = ReactDOM.createRoot(reactRoot);
      root.render(<EmbedFixedAgentClient appConfig={appConfig} />);
    })
    .catch((err) => {
      console.error('Voice Agent embed error - Error loading app config:', err);
    });
} else {
  console.error(
    'Voice Agent embed error - no data-agent-id attribute found on script tag. This is required!'
  );
}
