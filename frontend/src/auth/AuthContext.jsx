import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { hasPermission } from './permissions.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [company, setCompany] = useState(null);
  const [suspended, setSuspended] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    return api
      .getMe()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null));
  }, []);

  const refreshCompany = useCallback(() => {
    return api
      .getCompanyMe()
      .then((res) => {
        setCompany(res);
        setSuspended(false);
      })
      .catch((err) => {
        setCompany(null);
        setSuspended(err.detail?.error === 'subscription_suspended');
      });
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Platform-admin accounts belong to no company — never fetch/hold company
  // data for one, so the module-gated company UI never renders for them.
  useEffect(() => {
    if (user && !user.is_platform_admin && user.company_id) {
      refreshCompany();
    } else {
      setCompany(null);
    }
  }, [user, refreshCompany]);

  async function login(contact, password) {
    const res = await api.login(contact, password);
    setUser(res.user);
    return res.user;
  }

  async function logout() {
    await api.logout();
    setUser(null);
    setCompany(null);
  }

  const can = (permission) => hasPermission(user, permission);
  const canAny = (...permissions) => permissions.some((p) => hasPermission(user, p));
  // A module missing from the company's saved config is treated as ON —
  // matches the backend default (lib/companies.js `defaultModules()`), so a
  // module a company never explicitly touched still shows up.
  const moduleEnabled = (key) => !company || company.modules?.[key] !== false;

  return (
    <AuthContext.Provider
      value={{
        user,
        company,
        suspended,
        loading,
        login,
        logout,
        refresh,
        refreshCompany,
        setUser,
        can,
        canAny,
        moduleEnabled,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
