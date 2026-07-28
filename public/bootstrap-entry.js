import { initLocalization } from "./i18n/index.js";

await initLocalization();

if (window.location.pathname.startsWith("/app/")) {
  await import("./native/app.js");
} else {
  await import("./app.js");
}
