import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useEffect } from "react";

export function useAdminAuth() {
  const [, setLocation] = useLocation();

  const { data, isLoading, isError } = useQuery<{ loggedIn: boolean; username?: string }>({
    queryKey: ["/admin/me"],
    queryFn: async () => {
      const res = await fetch("/admin/me");
      if (!res.ok) return { loggedIn: false };
      return res.json();
    },
    retry: false,
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    if (!isLoading && (isError || !data?.loggedIn)) {
      setLocation("/admin/login");
    }
  }, [isLoading, isError, data, setLocation]);

  return {
    isLoading,
    isAuthenticated: data?.loggedIn ?? false,
    username: data?.username,
  };
}
