'use client';

import { useMediaDeviceSelect } from '@livekit/components-react';
import { MicrophoneIcon, CaretDownIcon } from '@phosphor-icons/react';

export function MicSelector() {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind: 'audioinput',
  });

  return (
    <div className="relative group min-w-0 flex-shrink-0">
      <select
        value={activeDeviceId}
        onChange={(e) => setActiveMediaDevice(e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
        title="Select Microphone"
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Mic ${d.deviceId.slice(0, 4)}`}
          </option>
        ))}
        {devices.length === 0 && <option>No Mic</option>}
      </select>

      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-bg2 rounded-full text-xs font-medium text-fg2 border border-separator1 transition-colors group-hover:bg-bg3 group-hover:border-separator2">
        <MicrophoneIcon size={12} weight="bold" className="text-fg3 shrink-0" />
        <span className="truncate max-w-[80px] hidden sm:block">
          {devices.find((d) => d.deviceId === activeDeviceId)?.label || 'Default Mic'}
        </span>
        <CaretDownIcon size={12} weight="bold" className="text-fg4 shrink-0" />
      </div>
    </div>
  );
}
