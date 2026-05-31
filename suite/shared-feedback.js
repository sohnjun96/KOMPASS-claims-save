(function initKSuiteFeedback(globalScope) {
  const FEEDBACK_HOST_ID = "ksuite-toast-host";
  const DEFAULT_DURATION_MS = 3800;

  let hideTimer = null;
  let retryHandler = null;

  function ensureHost() {
    let host = document.getElementById(FEEDBACK_HOST_ID);
    if (host) return host;

    host = document.createElement("section");
    host.id = FEEDBACK_HOST_ID;
    host.className = "ksuite-toast is-hidden";
    host.setAttribute("aria-live", "polite");
    host.innerHTML = `
      <div class="ksuite-toast-content">
        <span class="ksuite-toast-message"></span>
        <div class="ksuite-toast-actions">
          <button class="ksuite-toast-btn ksuite-toast-retry is-hidden" type="button">다시 시도</button>
          <button class="ksuite-toast-btn ksuite-toast-close" type="button" aria-label="닫기">닫기</button>
        </div>
      </div>
    `;

    const retryButton = host.querySelector(".ksuite-toast-retry");
    const closeButton = host.querySelector(".ksuite-toast-close");
    retryButton?.addEventListener("click", () => {
      const run = retryHandler;
      hide();
      if (typeof run === "function") {
        run();
      }
    });
    closeButton?.addEventListener("click", () => hide());

    document.body.appendChild(host);
    return host;
  }

  function hide() {
    const host = document.getElementById(FEEDBACK_HOST_ID);
    if (!host) return;
    host.classList.add("is-hidden");
    host.classList.remove("is-error", "is-warn", "is-ok", "is-info");
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    retryHandler = null;
  }

  function show(options) {
    const {
      message = "",
      tone = "info",
      durationMs = DEFAULT_DURATION_MS,
      actionLabel = "",
      onAction = null
    } = options || {};

    if (!message) {
      hide();
      return;
    }

    const host = ensureHost();
    const messageEl = host.querySelector(".ksuite-toast-message");
    const retryButton = host.querySelector(".ksuite-toast-retry");

    messageEl.textContent = message;
    host.classList.remove("is-hidden", "is-error", "is-warn", "is-ok", "is-info");
    host.classList.add(
      tone === "error" ? "is-error" :
      tone === "warn" ? "is-warn" :
      tone === "ok" ? "is-ok" : "is-info"
    );

    if (typeof onAction === "function") {
      retryHandler = onAction;
      retryButton.textContent = actionLabel || "다시 시도";
      retryButton.classList.remove("is-hidden");
    } else {
      retryHandler = null;
      retryButton.classList.add("is-hidden");
    }

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (durationMs > 0) {
      hideTimer = setTimeout(() => {
        hideTimer = null;
        hide();
      }, durationMs);
    }
  }

  globalScope.KSUITE_FEEDBACK = Object.freeze({
    show,
    hide
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
