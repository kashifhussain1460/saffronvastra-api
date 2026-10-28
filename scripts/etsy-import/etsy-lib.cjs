// Shared helpers for the Etsy listing import: CSV parsing, slugs, SEO text, colours.
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadListings(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const head = rows[0];
  const at = (r, k) => (r[head.indexOf(k)] || "").trim();
  const used = new Set();
  return rows.slice(1).map((r, index) => {
    const title = at(r, "TITLE").replace(/\s+/g, " ");
    let slug = slugify(title);
    for (let n = 2; used.has(slug); n++) slug = `${slugify(title)}-${n}`;
    used.add(slug);
    const images = [];
    for (let i = 1; i <= 10; i++) if (at(r, `IMAGE${i}`)) images.push(at(r, `IMAGE${i}`));
    return {
      index: index + 1,
      title,
      slug,
      description: (r[head.indexOf("DESCRIPTION")] || "").replace(/\r\n/g, "\n").trim(),
      price: Number(at(r, "PRICE")),
      currency: at(r, "CURRENCY_CODE") || "INR",
      quantity: Number(at(r, "QUANTITY")) || 0,
      tags: at(r, "TAGS").split(",").map((t) => t.trim().replace(/_/g, " ")).filter(Boolean),
      materials: at(r, "MATERIALS").split(",").map((t) => t.trim()).filter(Boolean),
      images,
      sizes: at(r, "VARIATION 1 VALUES").split(",").map((t) => t.trim()).filter(Boolean),
    };
  });
}

// Readable folder and URL name: lower case words, at most 70 characters, cut at a word boundary.
function slugify(title) {
  const base = title.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (base.length <= 70) return base;
  const cut = base.slice(0, 70);
  return cut.slice(0, cut.lastIndexOf("-") > 40 ? cut.lastIndexOf("-") : 70).replace(/-$/, "");
}

const COLOURS = [
  ["grey blue", "#6C7A89"], ["sage green", "#9CAF88"], ["olive green", "#6B7B3A"], ["mustard brown", "#8B6B23"],
  ["mustard yellow", "#D9A521"], ["rust orange", "#B7410E"], ["berry pink", "#B03060"], ["dusty rose", "#C9A0A0"],
  ["navy blue", "#1F2A44"], ["sky blue", "#87B5D8"], ["powder blue", "#B0C4DE"], ["chocolate brown", "#4B2E1E"],
  ["earthy brown", "#7B5B3A"], ["blue", "#2E5E9E"], ["plum", "#6A2C5C"], ["olive", "#6B7B3A"], ["red", "#B22222"],
  ["black", "#1A1A1A"], ["mustard", "#D9A521"], ["taupe", "#9C8B7A"], ["green", "#2F6B3A"], ["beige", "#D8C7A6"],
  ["fuchsia", "#C2185B"], ["brown", "#6B4423"], ["camel", "#B58B4C"], ["burgundy", "#6B1F2A"], ["cream", "#F2E8D5"],
  ["pink", "#E58BA8"], ["maroon", "#6B1F1F"], ["grey", "#808080"], ["gray", "#808080"], ["yellow", "#E3B505"],
  ["orange", "#D9731F"], ["ivory", "#F5F0E1"],
];

// The jacket colour is the first colour named in the title (the Etsy export has no colour column).
function guessColour(title) {
  const t = title.toLowerCase();
  let best = null;
  for (const [name, hex] of COLOURS) {
    const at = t.search(new RegExp(`\\b${name}\\b`));
    if (at >= 0 && (best === null || at < best.at || (at === best.at && name.length > best.name.length))) best = { at, name, hex };
  }
  if (!best) return { name: "Multicolour", hex: "#8A6D3B", guessed: true };
  return { name: best.name.replace(/\b\w/g, (c) => c.toUpperCase()), hex: best.hex, guessed: false };
}

function cutAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ") > max * 0.6 ? cut.lastIndexOf(" ") : max - 1).replace(/[\s,;:|-]+$/, "") + "…";
}

// Meta title: the lead of the title (before the first " - " or " | "), at most 60 characters with the brand.
function seoTitle(title) {
  const lead = title.split(/\s+[-|–]\s+/)[0].trim();
  const withBrand = `${lead} | Saffron Threads`;
  if (withBrand.length <= 60) return withBrand;
  return cutAtWord(lead, 60).replace(/…$/, "");
}

// Meta description: the opening sentences of the real description (title-like and heading lines skipped), 110-155 characters.
function seoDescription(description, title) {
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
  const paras = description.split(/\n\s*\n/).map((p) => p.replace(emoji, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const isHeading = (p) => /^(product details|styling ideas|care instructions?|details|sizing|shipping)/i.test(p) || /^[-•]/.test(p);
  const isTitleLike = (p) => p.length <= 90 && !/[.!?]$/.test(p);
  const body = paras.filter((p) => !isHeading(p) && !isTitleLike(p));
  let text = "";
  for (const p of body) {
    text = text ? text + " " + p : p;
    if (text.length >= 110) break;
  }
  if (!text) text = paras.find((p) => !isHeading(p)) || title;
  if (text.length <= 155) return text;
  const cut = text.slice(0, 155);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return stop >= 100 ? cut.slice(0, stop + 1) : cutAtWord(text, 155);
}

module.exports = { parseCsv, loadListings, slugify, guessColour, seoTitle, seoDescription, cutAtWord };
