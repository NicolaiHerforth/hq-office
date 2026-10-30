// Bun.serve: every request passes the checks that need the raw request (its origin and the caller's address),
// then goes to the router.
import { HOST, LEGACY_OWNER_WHO, OWNER, PORT, TRUSTED_ORIGINS } from "./config.ts";
import { handle } from "./router.ts";
import { json } from "./json.ts";
import { bump, secrets } from "./push.ts";
import { notifyAllHqs } from "./hq-link.ts";
import { event } from "./events.ts";
import { redactEverywhere } from "./redact.ts";
import { answerWithSecrets } from "./asks.ts";
import { isSecretPath, originAllowed, secretGuard, secretRoute } from "./secrets.ts";
import { handover, lostBook } from "./secret-ledger.ts";
import { expiresText } from "../client/secrets/expiry.js";

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    // A page on another origin gets nothing, not even a read, unless the owner listed it in HUD_TRUSTED_ORIGINS.
    if (!originAllowed(req, HOST) && !TRUSTED_ORIGINS.includes(req.headers.get("origin") ?? "")) return json({ error: "forbidden" }, 403);
    const ip = server.requestIP(req)?.address;
    if (isSecretPath(path)) {
      return secretRoute(req, path, ip, secrets, {
        host: HOST,
        trusted: TRUSTED_ORIGINS,
        onRedact: (name, value) => {
          const out = redactEverywhere(value, name);
          event("hud", `redacted ${name} from ${out.rows} stored ${out.rows === 1 ? "row" : "rows"}`);
          bump();
          return out;
        },
        onCopy: (name) => {
          event(OWNER, `copied ${name}`);
          bump();
        },
        lost: lostBook,
        handover,
        // Secrets are shared by every floor: every floor's HQ hears of one the owner sets.
        onSet: (m) => {
          if (m.by === "owner" || m.by === LEGACY_OWNER_WHO) notifyAllHqs(`HUD secret from ${OWNER}: ${m.name}, ${expiresText(m.expiresAt)}; read it with: hud secret get ${m.name} | <command>`);
        },
      });
    }
    // Secrets filled in on a question card: checked against the caller's address, which only this level knows.
    const askSecrets = req.method === "POST" ? path.match(/^\/api\/asks\/(\d+)\/secrets$/) : null;
    if (askSecrets) {
      if (req.headers.get("x-hud") !== "1") return json({ error: "forbidden" }, 403);
      const refused = secretGuard(req, ip, HOST, TRUSTED_ORIGINS);
      if (refused) return refused;
      try {
        answerWithSecrets(Number(askSecrets[1]), await req.json().catch(() => ({})));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      bump();
      return json({ ok: true });
    }
    return handle(req);
  },
});
