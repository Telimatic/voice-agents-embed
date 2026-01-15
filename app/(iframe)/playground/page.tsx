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
    <div className="h-screen w-full p-4">
      <div className="mx-auto h-full max-h-[600px] w-full max-w-lg">
        <PlaygroundAgentClient appConfig={appConfig} agentName={agentName} />
      </div>
    </div>
  );
}
