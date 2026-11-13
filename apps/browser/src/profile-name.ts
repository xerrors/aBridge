/// <reference types="chrome" />
export const fallbackProfileName = "Chrome · Profile";

interface ProfileNameApi {
  permissions: { contains(permissions: chrome.permissions.Permissions): Promise<boolean> };
  identity: {
    getProfileUserInfo(details: chrome.identity.ProfileDetails): Promise<chrome.identity.ProfileUserInfo>;
  };
}

/** Read only an already-granted permission; requesting it belongs to the user's click handler. */
export async function profileDeviceName(api: ProfileNameApi): Promise<string> {
  try {
    if (!(await api.permissions.contains({ permissions: ["identity.email"] }))) return fallbackProfileName;
    const { email } = await api.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return email.trim() ? ("Chrome · " + email.trim()).slice(0, 80) : fallbackProfileName;
  } catch {
    return fallbackProfileName;
  }
}

/** Late account reads must preserve manual edits and restored binding/authorization names. */
export function registrationDeviceName(
  current: string,
  edited: boolean,
  saved: string | undefined,
  suggestion: string,
): string {
  return edited ? current : saved || suggestion;
}
