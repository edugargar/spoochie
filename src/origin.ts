/**
 * Where this copy of spoochie comes from: the GitHub repo the plugin is installed from
 * and the binaries are downloaded from, and the marketplace name. Written in one file so
 * a fork only has to touch this one, and overridable with SPOOCHIE_ORIGIN for anyone who
 * wants to point at their copy without touching anything.
 *
 * Format: "owner/repo" on GitHub. The marketplace is named after the owner.
 */
export const ORIGIN: string = (process.env.SPOOCHIE_ORIGIN ?? process.env.SPOOCHIE_ORIGEN) ?? "edugargar/spoochie";
export const OWNER = ORIGIN.split("/")[0];
export const PLUGIN = `spoochie@${OWNER}`;
