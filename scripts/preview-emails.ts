// Renders the email templates with sample data to HTML files and prints their paths. No mail is sent, no server is needed.
//   node node_modules/tsx/dist/cli.mjs scripts/preview-emails.ts [outDir]
// Images normally load from APP_URL (the storefront); here they point at Website/public so the preview works offline.
import fs from "fs";
import path from "path";
import { TEMPLATE_NAMES, renderSample } from "../src/modules/email/email.templates.js";
import { siteUrl } from "../src/modules/email/email.layout.js";

const out = path.resolve(process.argv[2] || "reports/email-preview");
fs.mkdirSync(out, { recursive: true });
const publicDir = path.resolve("../Website/public").replace(/\\/g, "/");
const imagesBase = siteUrl("/email/");
for (const name of TEMPLATE_NAMES) {
  const mail = renderSample(name, "preview");
  const html = mail.html.split(imagesBase).join(`file:///${publicDir}/email/`);
  const file = path.join(out, `${name}.html`);
  fs.writeFileSync(file, html);
  console.log(file);
}
