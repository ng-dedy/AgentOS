"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiRequestError } from "@/lib/api";
import type { Me } from "@/lib/types";

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ me: null, loading: true, refresh: async () => {}, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = async () => {
    try {
      setMe(await api.get<Me>("/auth/me"));
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!loading && !me && pathname !== "/login") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, me, pathname, router]);

  const logout = async () => {
    await api.post("/auth/logout");
    setMe(null);
    router.replace("/login");
  };

  return <AuthContext.Provider value={{ me, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
