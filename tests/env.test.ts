import { expect, test } from "bun:test";
import { envVar } from "../src/paths.ts";
import { asideMode } from "../src/aside.ts";

/**
 * Up to 0.9.10 the environment variables had Spanish names, and the README told people
 * to set `SPOOCHIE_VENTANA=fondo`. Whoever set that keeps the behaviour they asked for.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { fn(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test("the English name wins, the old name and its old values still work", () => {
  withEnv({ SPOOCHIE_WINDOW: undefined, SPOOCHIE_VENTANA: "fondo" }, () => {
    expect(envVar("SPOOCHIE_WINDOW", "SPOOCHIE_VENTANA")).toBe("background");
  });
  withEnv({ SPOOCHIE_WINDOW: "background", SPOOCHIE_VENTANA: "ventana" }, () => {
    expect(envVar("SPOOCHIE_WINDOW", "SPOOCHIE_VENTANA")).toBe("background");
  });
  withEnv({ SPOOCHIE_NOTICE: undefined, SPOOCHIE_AVISO: "dialogo" }, () => {
    expect(envVar("SPOOCHIE_NOTICE", "SPOOCHIE_AVISO")).toBe("dialog");
  });
  withEnv({ SPOOCHIE_ASIDE_MODEL: undefined, SPOOCHIE_APARTE_MODELO: "opus" }, () => {
    expect(envVar("SPOOCHIE_ASIDE_MODEL", "SPOOCHIE_APARTE_MODELO")).toBe("opus");
  });
});

test("the old SPOOCHIE_VENTANA=fondo still keeps the aside in the background", () => {
  withEnv({ SPOOCHIE_WINDOW: undefined, SPOOCHIE_VENTANA: "fondo" }, () => {
    expect(["fondo", "background"]).toContain(asideMode());
  });
});
