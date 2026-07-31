const SETTINGS_GROUPS = Object.freeze({
  general: Object.freeze(["general"]),
  configuration: Object.freeze(["configuration", "usage"]),
  extensions: Object.freeze(["extensions", "chat"]),
  data: Object.freeze(["data"]),
});

const PANEL_TO_GROUP = Object.freeze(
  Object.fromEntries(
    Object.entries(SETTINGS_GROUPS).flatMap(([group, panels]) =>
      panels.map((panel) => [panel, group]),
    ),
  ),
);

export function normalizeSettingsGroup(destination = "general") {
  const normalized = destination === "auth" ? "configuration" : destination;
  return PANEL_TO_GROUP[normalized] || "general";
}

export function panelsForSettingsGroup(group = "general") {
  return SETTINGS_GROUPS[normalizeSettingsGroup(group)];
}
