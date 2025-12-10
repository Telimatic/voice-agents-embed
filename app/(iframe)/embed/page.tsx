import { headers } from 'next/headers';
import EmbedAgentClient from '@/components/embed-iframe/agent-client';
import { getAppConfig, getOrigin } from '@/lib/env';

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default async function Embed({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;

  const hdrs = await headers();
  const origin = getOrigin(hdrs);
  const appConfig = await getAppConfig(origin);

  // Add agentId from query param to appConfig
  if (agentId) {
    appConfig.agentId = agentId;
  }

  return <EmbedAgentClient appConfig={appConfig} />;
}
