/**
 * Secrets in the macOS keychain instead of a text file.
 *
 * `config.json` holds the ed25519 private key you sign with, the Nostr secret key that
 * decrypts everything sent to you, and the team's bot token. All three in the clear,
 * protected only by the file permissions (0600). That means any process running as you
 * (an npm dependency, a script pasted from the internet, anything) can impersonate you by
 * reading a file.
 *
 * Not in the keychain: getting them out of there goes through the system, which the user
 * controls. It is not magic and does not protect against everything, but it swaps "read a
 * file" for "ask the system for permission", which is exactly the difference that matters.
 *
 * It is optional and turned on by hand (`spoochie keychain on`). An automatic migration of
 * someone's keys is the kind of thing that, if it goes wrong, locks that person out of
 * their own contacts with no way back.
 */
import { execFileSync } from "node:child_process";

/** What stays written in config.json in place of the secret. */
export const MARKER = "@llavero";

const SERVICE = "spoochie";

export function available(): boolean {
  if (process.platform !== "darwin") return false;
  try { execFileSync("security", ["-h"], { stdio: "ignore" }); return true; } catch { return false; }
}

export function store(account: string, secret: string): boolean {
  try {
    // -U updates it if it was already there; -w passes it as an argument, which is how `security` does it.
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", secret], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

export function read(account: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

export function remove(account: string): boolean {
  try { execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" }); return true; } catch { return false; }
}

/** The three secrets to move, with the name they live under in the keychain. These
 *  account names are already stored in people's keychains: do not rename them. */
export const ACCOUNTS = { firma: "clave-de-firma", nostr: "clave-nostr", bot: "token-de-bot" } as const;
