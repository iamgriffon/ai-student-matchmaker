(() => {
  const DEFAULT_LOCALE = "en-US";
  const SUPPORTED_LOCALES = [DEFAULT_LOCALE, "pt-BR"];
  const STORAGE_KEY = "vestibulandos.locale";
  const TRANSLATED_ATTRIBUTES = ["aria-label", "placeholder", "title"];
  const originals = new WeakMap();
  const attributeOriginals = new WeakMap();
  let catalogs = {};
  let sourceAliases = {};
  let templates = [];
  let scheduled = false;
  let locale = DEFAULT_LOCALE;
  try { const saved = localStorage.getItem(STORAGE_KEY); if (SUPPORTED_LOCALES.includes(saved)) locale = saved; }
  catch { /* Language selection still works when browser storage is unavailable. */ }
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function t(source, values = {}) {
    const canonical = sourceAliases[source] ?? source;
    let translated = catalogs[locale]?.[canonical] ?? canonical;
    if (translated === canonical) {
      for (const template of templates) {
        const match = template.pattern.exec(canonical);
        if (!match) continue;
        translated = catalogs[locale]?.[template.key] ?? template.key;
        template.names.forEach((name, index) => { translated = translated.replaceAll(`{${name}}`, match[index + 1]); });
        break;
      }
    }
    for (const [name, value] of Object.entries(values)) translated = translated.replaceAll(`{${name}}`, String(value));
    return translated;
  }

  function translateNode(node) {
    if (!node.parentElement || node.parentElement.closest("script, style, pre, code, [data-i18n-skip]")) return;
    const current = node.nodeValue;
    const previous = originals.get(node);
    const source = previous && previous.translated === current ? previous.source : current;
    const text = source.trim();
    const translated = text ? source.replace(text, t(text)) : source;
    originals.set(node, { source, translated });
    if (current !== translated) node.nodeValue = translated;
  }
  function translateDocument() {
    scheduled = false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) translateNode(walker.currentNode);
    for (const element of document.querySelectorAll("[aria-label], [placeholder], [title]")) {
      const previous = attributeOriginals.get(element) ?? {};
      for (const name of TRANSLATED_ATTRIBUTES) {
        if (!element.hasAttribute(name)) continue;
        const current = element.getAttribute(name);
        const remembered = previous[name];
        const source = remembered && remembered.translated === current ? remembered.source : current;
        const translated = t(source);
        previous[name] = { source, translated };
        if (current !== translated) element.setAttribute(name, translated);
      }
      attributeOriginals.set(element, previous);
    }
    const title = document.querySelector("title");
    if (title) translateNode(title.firstChild);
    document.documentElement.lang = locale;
  }
  function scheduleTranslation() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(translateDocument);
  }
  function setLocale(value) {
    if (!SUPPORTED_LOCALES.includes(value)) return;
    locale = value;
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* Optional persistence. */ }
    for (const select of document.querySelectorAll("[data-language-select]")) select.value = locale;
    document.dispatchEvent(new CustomEvent("locale-changed", { detail: { locale } }));
    translateDocument();
  }
  window.i18n = { t, get locale() { return locale; }, setLocale };
  // Text catalogs also cover markup rebuilt by the existing vanilla-JS views.
  // Remember source text so switching languages never translates a previous translation.
  new MutationObserver(scheduleTranslation).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: TRANSLATED_ATTRIBUTES });
  for (const select of document.querySelectorAll("[data-language-select]")) {
    select.value = locale;
    select.addEventListener("change", (event) => setLocale(event.target.value));
  }
  window.i18n.ready = Promise.all(["en-US", "pt-BR", "source"].map(async (name) => {
    const response = await fetch(`/locales/${name}.json`);
    if (!response.ok) throw new Error("Could not load translations.");
    return [name, await response.json()];
  })).then((entries) => {
    catalogs = Object.fromEntries(entries);
    sourceAliases = catalogs.source;
    templates = Object.keys(catalogs[DEFAULT_LOCALE]).filter((key) => key.includes("{")).map((key) => {
      const names = [...key.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const parts = key.split(/\{[^}]+\}/g).map(escapePattern);
      return { key, names, pattern: new RegExp(`^${parts.join("(.+?)")}$`) };
    });
    setLocale(locale);
  }).catch((error) => { console.error(error.message); setLocale(DEFAULT_LOCALE); });
})();
