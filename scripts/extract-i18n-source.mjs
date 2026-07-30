import { readFileSync } from "node:fs";
import { JSDOM } from "../node_modules/jsdom/lib/api.js";

const sourcePath = process.argv[2] || "public/index.html";
const document = new JSDOM(readFileSync(sourcePath, "utf8")).window.document;
const strings = new Set();
const skippedTags = new Set(["CODE", "SCRIPT", "STYLE", "SVG"]);
const walker = document.createTreeWalker(document.body, document.defaultView.NodeFilter.SHOW_TEXT);

while (walker.nextNode()) {
  const parent = walker.currentNode.parentElement;
  const value = walker.currentNode.nodeValue.replace(/\s+/g, " ").trim();
  if (value && !skippedTags.has(parent?.tagName)) strings.add(value);
}

for (const element of document.querySelectorAll("[aria-label], [placeholder], [title]")) {
  for (const attribute of ["aria-label", "placeholder", "title"]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) strings.add(value);
  }
}

for (const value of [...strings].sort((left, right) => left.localeCompare(right))) {
  console.log(value);
}

document.defaultView.close();
