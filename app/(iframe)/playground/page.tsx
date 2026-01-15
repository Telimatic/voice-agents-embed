import { headers } from 'next/headers';
import PlaygroundAgentClient from '@/components/embed-playground/agent-client';
import { getAppConfig, getOrigin } from '@/lib/env';

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default async function Playground({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;
  const agentName = typeof params.name === 'string' ? params.name : undefined;

  const hdrs = await headers();
  const origin = getOrigin(hdrs);
  const appConfig = await getAppConfig(origin);

  // Add agentId from query param to appConfig
  if (agentId) {
    appConfig.agentId = agentId;
  }

  return (
    <div className="w-full h-screen p-4">
      <div className="w-full max-w-lg mx-auto h-full max-h-[600px]">
        <PlaygroundAgentClient appConfig={appConfig} agentName={agentName} />
      </div>
    </div>
  );
}
