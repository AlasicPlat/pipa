import { useCallback, useEffect, useState } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { listConnections } from "../../lib/tauriClient";

interface ConnectionsState {
  profiles: ConnectionProfile[];
  selectedConnectionId: string | null;
  loading: boolean;
  error: string | null;
  selectConnection: (id: string) => void;
  addProfile: (profile: ConnectionProfile) => void;
  reload: () => Promise<void>;
}

/**
 * Owns saved profiles, sidebar selection, loading state, and the current actionable error.
 * Parameters: none.
 * @returns Connection state plus commands for selection, local insertion, and reload.
 * Side effects: loads non-secret profiles from the Tauri backend after mounting.
 */
export function useConnections(): ConnectionsState {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Refreshes the non-secret profile list and reports one recoverable loading error.
   * Parameters: none.
   * @returns A promise that settles after the backend request completes.
   * Side effects: invokes Tauri and replaces the hook's profiles/loading/error state.
   */
  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setProfiles(await listConnections());
    } catch {
      setError("无法加载连接。请检查本地凭据存储，然后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Selects a connection for future workspace actions without mutating any query tab.
   * @param id - Stable identifier of the connection to select.
   * @returns Nothing (`void`).
   * Side effects: updates only the selected connection identifier.
   */
  const selectConnection = useCallback((id: string): void => {
    setSelectedConnectionId(id);
  }, []);

  /**
   * Inserts or replaces a backend-confirmed profile and selects it.
   * @param profile - Saved non-secret profile returned by Tauri.
   * @returns Nothing (`void`).
   * Side effects: updates the in-memory profile list and selected identifier.
   */
  const addProfile = useCallback((profile: ConnectionProfile): void => {
    setProfiles((currentProfiles) => {
      const existingIndex = currentProfiles.findIndex((item) => item.id === profile.id);
      if (existingIndex === -1) {
        return [...currentProfiles, profile];
      }

      return currentProfiles.map((item) => (item.id === profile.id ? profile : item));
    });
    setSelectedConnectionId(profile.id);
  }, []);

  return {
    profiles,
    selectedConnectionId,
    loading,
    error,
    selectConnection,
    addProfile,
    reload,
  };
}
