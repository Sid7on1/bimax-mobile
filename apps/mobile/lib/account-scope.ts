let accountId: string | null = null;
export function setActiveAccount(id: string | null): boolean {
  if (id !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new Error("Invalid account identifier");
  const changed = accountId !== id;
  accountId = id;
  return changed;
}
export function requireActiveAccount(): string {
  if (!accountId) throw new Error("Sign in to access account data");
  return accountId;
}
export function accountStorageKey(name: string, owner = requireActiveAccount()): string {
  return `bimax.${owner}.${name}`;
}

export function isActiveAccount(owner: string): boolean {
  return accountId === owner;
}
