import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("i18n translates disability labels in standalone and composite text in both directions", async () => {
  const catalogs = Object.fromEntries(await Promise.all(["en-US", "pt-BR", "source"].map(async (name) =>
    [name, JSON.parse(await readFile(new URL(`../locales/${name}.json`, import.meta.url), "utf8"))],
  )));
  const window: { i18n?: { ready: Promise<void>; setLocale(locale: string): void; t(value: string): string } } = {};
  runInNewContext(await readFile(new URL("../i18n.js", import.meta.url), "utf8"), {
    window, console, queueMicrotask,
    localStorage: { getItem: () => null, setItem: () => {} },
    NodeFilter: { SHOW_TEXT: 4 },
    CustomEvent: class {},
    MutationObserver: class { observe() {} },
    document: {
      body: {}, documentElement: {},
      querySelectorAll: () => [], querySelector: () => null,
      dispatchEvent() {}, createTreeWalker: () => ({ nextNode: () => false }),
    },
    fetch: async (url: string) => ({ ok: true, json: async () => catalogs[url.split("/").at(-1)!.replace(".json", "")] }),
  });
  await window.i18n!.ready;
  const i18n = window.i18n!;
  i18n.setLocale("pt-BR");
  expect(i18n.t("Has disability")).toBe("PCD");
  expect(i18n.t("Score 70 · R$4,000 · Has disability")).toBe("Nota 70 · R$4,000 · PCD");
  expect(i18n.t("Score 70 · 21 years · Has disability")).toBe("Nota 70 · 21 anos · PCD");
  i18n.setLocale("en-US");
  expect(i18n.t("Has disability")).toBe("Has disability");
  expect(i18n.t("Score 70 · R$4,000 · Has disability")).toBe("Score 70 · R$4,000 · Has disability");
});
