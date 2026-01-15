'use client';

import { useMediaDeviceSelect } from '@livekit/components-react';
import { CaretDownIcon, MicrophoneIcon } from '@phosphor-icons/react';

export function MicSelector() {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind: 'audioinput',
  });

  return (
    <div className="group relative min-w-0 flex-shrink-0">
      <select
        value={activeDeviceId}
        onChange={(e) => setActiveMediaDevice(e.target.value)}
        className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
        title="Select Microphone"
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Mic ${d.deviceId.slice(0, 4)}`}
          </option>
        ))}
        {devices.length === 0 && <option>No Mic</option>}
      </select>

      <div className="bg-bg2 text-fg2 border-separator1 group-hover:bg-bg3 group-hover:border-separator2 flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors">
        <MicrophoneIcon size={12} weight="bold" className="text-fg3 shrink-0" />
        <span className="hidden max-w-[80px] truncate sm:block">
          {devices.find((d) => d.deviceId === activeDeviceId)?.label || 'Default Mic'}
        </span>
        <CaretDownIcon size={12} weight="bold" className="text-fg4 shrink-0" />
      </div>
    </div>
  );
}
