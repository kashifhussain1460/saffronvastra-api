// Shows how the SMTP_* settings are understood and signs in to the server once. No email is sent and the password
// is never printed.   npx tsx scripts/check-smtp.ts
import { resolveSmtpSettings } from "../src/modules/email/smtp.config.js";
import { checkSmtp } from "../src/modules/email/email.service.js";

const s = resolveSmtpSettings();
console.log(
  JSON.stringify(
    { configured: s.configured, host: s.host, port: s.port, security: s.mode, secure: s.secure, requireTLS: s.requireTLS, user: s.user, passwordSet: s.hasPassword, from: s.from, fromSource: s.fromSource, warnings: s.warnings },
    null,
    2
  )
);
void checkSmtp().then((result) => {
  console.log("sign-in check:", result);
  process.exit(result?.ok ? 0 : 1);
});
