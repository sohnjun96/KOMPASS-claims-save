(() => {
  const BADGE_CLASS = "ksuite-version-badge";
  const STYLE_ID = "ksuite-version-badge-style";

  function resolveVersionText() {
    try {
      const manifestVersion = chrome?.runtime?.getManifest?.()?.version;
      if (manifestVersion) {
        return `v${manifestVersion}`;
      }
    } catch {
      // no-op
    }
    const fallback = String(globalThis.KSUITE_APP_VERSION || "").trim();
    return fallback || "";
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.${BADGE_CLASS}{
  display:inline-flex;
  align-items:center;
  margin-left:8px;
  padding:3px 9px;
  border-radius:999px;
  border:1px solid rgba(15,52,110,0.34);
  background:linear-gradient(135deg, rgba(15,52,110,0.96), rgba(29,78,216,0.92));
  color:#ffffff;
  font-size:11px;
  font-weight:900;
  letter-spacing:0.02em;
  line-height:1.2;
  vertical-align:middle;
  box-shadow:0 4px 12px rgba(15,52,110,0.2);
}

.topbar .${BADGE_CLASS},
.brand-copy .${BADGE_CLASS}{
  border-color:rgba(255,255,255,0.78);
  background:rgba(255,255,255,0.96);
  color:#0b1f44;
  box-shadow:0 6px 14px rgba(4,12,24,0.2);
}
`;
    document.head.appendChild(style);
  }

  function upsertBadge(target, versionText) {
    if (!target) return;
    let badge = target.querySelector(`.${BADGE_CLASS}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = BADGE_CLASS;
      target.appendChild(badge);
    }
    badge.textContent = versionText;
  }

  function patchExistingVersionNodes(versionText) {
    const existing = document.querySelectorAll(".badge-beta, [data-ksuite-version], .ksuite-version-badge");
    existing.forEach((node) => {
      node.classList.add(BADGE_CLASS);
      node.textContent = versionText;
    });
  }

  function patchTargetNodes(versionText) {
    const targets = document.querySelectorAll("[data-ksuite-version-target]");
    targets.forEach((target) => upsertBadge(target, versionText));
  }

  function patchFallbackTitle(versionText) {
    const selectors = [
      ".logo-area h1",
      ".hero-title-row h1",
      ".app-header h1",
      ".header .title",
      ".brand-copy h1",
      ".wrap .card h1",
      "h1"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      upsertBadge(node, versionText);
      return;
    }
  }

  const versionText = resolveVersionText();
  if (!versionText) return;
  globalThis.KSUITE_APP_VERSION = versionText;

  ensureStyle();
  patchExistingVersionNodes(versionText);
  patchTargetNodes(versionText);
  patchFallbackTitle(versionText);
})();
