import { useEffect, useState } from 'react';
import { ParticipantKind, RoomEvent } from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import { ATTR_DISPLAY_NAME, ATTR_ROLE } from '@/lib/screenshare-protocol';

export interface Staff {
  identity: string;
  name: string;
}

const EMPTY: { reps: Staff[]; observers: Staff[] } = { reps: [], observers: [] };

/**
 * TLZ-561 (D7/D12). Human team members in the call, by the role attribute the dashboard
 * mints into their token. Only STANDARD participants carrying a known role count: agents,
 * SIP callers and anything else are ignored.
 */
export function useStaffParticipants() {
  const room = useRoomContext();
  const [staff, setStaff] = useState(EMPTY);

  useEffect(() => {
    const evaluate = () => {
      const reps: Staff[] = [];
      const observers: Staff[] = [];
      room.remoteParticipants.forEach((p) => {
        if (p.kind !== ParticipantKind.STANDARD) return;
        const role = p.attributes?.[ATTR_ROLE];
        const entry = {
          identity: p.identity,
          name: p.attributes?.[ATTR_DISPLAY_NAME]?.trim() || 'Team member',
        };
        if (role === 'rep') reps.push(entry);
        else if (role === 'observer') observers.push(entry);
      });
      setStaff((prev) =>
        JSON.stringify(prev) === JSON.stringify({ reps, observers }) ? prev : { reps, observers }
      );
    };
    evaluate();
    room.on(RoomEvent.ParticipantConnected, evaluate);
    room.on(RoomEvent.ParticipantDisconnected, evaluate);
    room.on(RoomEvent.ParticipantAttributesChanged, evaluate);
    return () => {
      room.off(RoomEvent.ParticipantConnected, evaluate);
      room.off(RoomEvent.ParticipantDisconnected, evaluate);
      room.off(RoomEvent.ParticipantAttributesChanged, evaluate);
    };
  }, [room]);

  return staff;
}
