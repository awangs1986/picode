export const DEFAULT_LOCALE = "en-US";
export const SUPPORTED_LOCALES = Object.freeze([
  { id: "en-US", nativeName: "English" },
  { id: "zh-CN", nativeName: "简体中文" },
]);

const STORAGE_KEY = "picot:locale";
const SKIPPED_TEXT_TAGS = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "SVG", "TEXTAREA"]);
const packCache = new Map();
const translatedTextNodes = new WeakMap();
const translatedAttributes = new WeakMap();

let activeLocale = readStoredLocale();
let fallbackMessages = new Map();
let activeMessages = new Map();
let sourceMessageIds = new Map();
let initialization = null;

function normalizeLocale(locale) {
  const requested = String(locale || "")
    .trim()
    .toLowerCase();
  const exact = SUPPORTED_LOCALES.find((entry) => entry.id.toLowerCase() === requested);
  if (exact) return exact.id;
  const language = requested.split("-")[0];
  return SUPPORTED_LOCALES.find((entry) => entry.id.toLowerCase().startsWith(`${language}-`))?.id;
}

function readStoredLocale() {
  try {
    return normalizeLocale(localStorage.getItem(STORAGE_KEY)) || DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function normalizeSource(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseLanguagePack(xmlText) {
  const document = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error("Invalid XML language pack");
  }

  const root = document.documentElement;
  if (root.tagName !== "languagePack" || root.getAttribute("version") !== "1") {
    throw new Error("Unsupported XML language pack format");
  }

  const locale = normalizeLocale(root.getAttribute("locale"));
  if (!locale) throw new Error("Unsupported language pack locale");

  const messages = new Map();
  for (const message of root.querySelectorAll("message[id]")) {
    const id = message.getAttribute("id")?.trim();
    if (!id || messages.has(id)) throw new Error(`Duplicate or empty message id: ${id || "?"}`);
    messages.set(id, message.textContent?.trim() || "");
  }
  return { locale, messages };
}

async function loadPack(locale) {
  if (packCache.has(locale)) return packCache.get(locale);
  const response = await fetch(new URL(`./locales/${locale}.xml`, import.meta.url));
  if (!response.ok) throw new Error(`Cannot load ${locale} language pack (${response.status})`);
  const pack = parseLanguagePack(await response.text());
  if (pack.locale !== locale) throw new Error(`Language pack locale mismatch: ${pack.locale}`);
  packCache.set(locale, pack.messages);
  return pack.messages;
}

function rebuildSourceIndex() {
  sourceMessageIds = new Map();
  for (const [id, value] of fallbackMessages) {
    const source = normalizeSource(value);
    if (source && !sourceMessageIds.has(source)) sourceMessageIds.set(source, id);
  }
}

export function t(id, variables = {}, fallback = id) {
  let value = activeMessages.get(id) ?? fallbackMessages.get(id) ?? fallback;
  value = String(value);
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : match,
  );
}

export function getLocale() {
  return activeLocale;
}

export function formatNumber(value, options = {}) {
  return new Intl.NumberFormat(activeLocale, options).format(Number(value || 0));
}

export function formatDate(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(activeLocale, options).format(date);
}

function messageForSource(source) {
  const id = sourceMessageIds.get(normalizeSource(source));
  return id ? { id, value: t(id, {}, source) } : null;
}

function translateTextNode(node) {
  const saved = translatedTextNodes.get(node);
  const source = saved?.source || node.nodeValue;
  const match = String(source || "").match(/^(\s*)([\s\S]*?)(\s*)$/);
  const message = saved
    ? { id: saved.id, value: t(saved.id, {}, saved.trimmed) }
    : messageForSource(match?.[2]);
  if (!message || !match) return;
  translatedTextNodes.set(node, { id: message.id, source, trimmed: match[2] });
  node.nodeValue = `${match[1]}${message.value}${match[3]}`;
}

function shouldSkipTextNode(node) {
  const parent = node.parentElement;
  return (
    !parent ||
    SKIPPED_TEXT_TAGS.has(parent.tagName) ||
    parent.isContentEditable ||
    parent.closest("[data-i18n-ignore], .messages, .message-content")
  );
}

function translateAttribute(element, attribute) {
  let saved = translatedAttributes.get(element);
  const record = saved?.get(attribute);
  const original = record?.source || element.getAttribute(attribute);
  const message = record
    ? { id: record.id, value: t(record.id, {}, original) }
    : messageForSource(original);
  if (!message) return;
  if (!saved) {
    saved = new Map();
    translatedAttributes.set(element, saved);
  }
  saved.set(attribute, { id: message.id, source: original });
  element.setAttribute(attribute, message.value);
}

function translateExplicitElement(element) {
  const textId = element.dataset.i18n;
  if (textId) element.textContent = t(textId, {}, element.textContent);
  for (const attribute of ["aria-label", "placeholder", "title"]) {
    const id =
      element.dataset[
        `i18n${attribute.replace(/(^|-)([a-z])/g, (_, _dash, char) => char.toUpperCase())}`
      ];
    if (id) element.setAttribute(attribute, t(id, {}, element.getAttribute(attribute) || ""));
  }
}

export function applyTranslations(root = document) {
  const treeRoot = root.nodeType === Node.DOCUMENT_NODE ? root.body : root;
  if (!treeRoot) return;

  const walker = document.createTreeWalker(treeRoot, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!shouldSkipTextNode(walker.currentNode)) translateTextNode(walker.currentNode);
  }

  for (const element of treeRoot.querySelectorAll("[aria-label], [placeholder], [title]")) {
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      if (element.hasAttribute(attribute)) translateAttribute(element, attribute);
    }
  }
  for (const element of treeRoot.querySelectorAll("[data-i18n]")) translateExplicitElement(element);
}

function updateLocaleControls(root = document) {
  for (const select of root.querySelectorAll("[data-language-select]")) {
    select.value = activeLocale;
    if (select.dataset.languageBound === "true") continue;
    select.dataset.languageBound = "true";
    select.addEventListener("change", () => {
      void setLocale(select.value);
    });
  }
}

export async function setLocale(locale, root = document) {
  const normalized = normalizeLocale(locale);
  if (!normalized) throw new Error(`Unsupported locale: ${locale}`);
  if (fallbackMessages.size === 0) fallbackMessages = await loadPack(DEFAULT_LOCALE);
  activeMessages = normalized === DEFAULT_LOCALE ? fallbackMessages : await loadPack(normalized);
  activeLocale = normalized;
  rebuildSourceIndex();
  try {
    localStorage.setItem(STORAGE_KEY, activeLocale);
  } catch {}
  document.documentElement.lang = activeLocale;
  applyTranslations(root);
  updateLocaleControls(root);
  window.dispatchEvent(
    new CustomEvent("picot:locale-changed", { detail: { locale: activeLocale } }),
  );
  return activeLocale;
}

export function initLocalization(root = document) {
  if (!initialization) {
    initialization = setLocale(activeLocale, root).catch(async (error) => {
      console.error("[i18n] Failed to initialize selected language:", error);
      return setLocale(DEFAULT_LOCALE, root);
    });
  }
  return initialization;
}
