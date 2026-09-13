"use client";

import { createContext, useContext, type ReactNode } from "react";

// Where "back" goes from a manage page, decided by the server because it depends on SURFACE: the studio
// returns to its dashboard, a client to the booking list. Passed as context rather than threaded as a
// prop because every manage frame -- the form, the loading state, the retry, the error -- renders the
// same BrandHeader, and only that one component needs to know.
//
// Absence is meaningful: the public booking flow renders no provider, so it gets no back link, which is
// correct. A visitor part-way through choosing a time should not be invited to abandon it.
export type BackTarget = { href: string; label: string };
const BackTargetContext = createContext<BackTarget | null>(null);

export function BackTargetProvider({ value, children }: { value: BackTarget; children: ReactNode }) {
  return <BackTargetContext.Provider value={value}>{children}</BackTargetContext.Provider>;
}

export function useBackTarget() { return useContext(BackTargetContext); }
