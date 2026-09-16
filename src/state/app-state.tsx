import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Flash } from "../lib/types";

type AppState = {
  flash: Flash | null;
  setFlash: (flash: Flash | null) => void;
};

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const value = useMemo(() => ({ flash, setFlash }), [flash]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
