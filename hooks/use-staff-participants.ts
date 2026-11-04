import { useEffect, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import { isStaffParticipant } from '@/hooks/use-screen-viewer-permissions';
import { ATTR_DISPLAY_NAME, ATTR_ROLE } from '@/lib/screenshare-protocol';

export interface Staff {
  identity: string;
  name: string;
}

const EMPTY: { reps: Staff[]; observers: Staff[] } = { reps: [], observers: [] };

/**
 * TLZ-561 (D7/D12). Human team members in the call, by the role attribute the dashboard
 * mints into their token. Same predicate as the viewer-permission gate (isStaffParticipant): a known
 * role and not an AGENT or SIP participant.
 */
export function useStaffParticipants() {
  const room = useRoomContext();
  const [staff, setStaff] = useState(EMPTY);

  useEffect(() => {
    const evaluate = () => {
      const reps: Staff[] = [];
      const observers: Staff[] = [];
      room.remoteParticipants.forEach((p) => {
        if (!isStaffParticipant(p)) return;
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
