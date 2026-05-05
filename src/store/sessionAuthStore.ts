import { create } from "zustand";
import type { KeyFileZoneV1 } from "@/lib/keyFile";

export type KeySessionState = {
  username: string;
  zones: KeyFileZoneV1[];
  roles: string[];
  isAdmin: boolean;
};

type SessionAuthStore = {
  keySession: KeySessionState | null;
  setKeySession: (session: KeySessionState | null) => void;
};

export const useSessionAuthStore = create<SessionAuthStore>((set) => ({
  keySession: null,
  setKeySession: (session) => set({ keySession: session }),
}));
