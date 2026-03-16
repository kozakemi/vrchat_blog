import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n, { persistLanguage } from "@/i18n";

const LANG_CYCLE = ["zh", "ja", "en"] as const;
type AppLanguage = (typeof LANG_CYCLE)[number];

function getNextLanguage(current: string): AppLanguage {
  const currentIndex = LANG_CYCLE.indexOf(current as AppLanguage);
  if (currentIndex === -1) return LANG_CYCLE[0];
  return LANG_CYCLE[(currentIndex + 1) % LANG_CYCLE.length];
}

function getLanguageLabel(language: string) {
  if (language === "zh") return "中文";
  if (language === "ja") return "日本語";
  return "English";
}

type LoginMode = "key" | "guest";
type AuthState =
  | { status: "anonymous" }
  | { status: "authed"; mode: "key" }
  | { status: "authed"; mode: "guest"; nickname: string };

const STORAGE_AUTH_MODE_KEY = "td_auth_mode";
const STORAGE_GUEST_NICKNAME_KEY = "td_guest_nickname";

function loadAuthState(): AuthState {
  const mode = window.localStorage.getItem(STORAGE_AUTH_MODE_KEY);
  if (mode === "guest") {
    const nickname = window.localStorage.getItem(STORAGE_GUEST_NICKNAME_KEY) ?? "";
    if (nickname.trim()) return { status: "authed", mode: "guest", nickname };
  }
  return { status: "anonymous" };
}

function persistGuest(nickname: string) {
  window.localStorage.setItem(STORAGE_AUTH_MODE_KEY, "guest");
  window.localStorage.setItem(STORAGE_GUEST_NICKNAME_KEY, nickname);
}

function clearAuthPersistence() {
  window.localStorage.removeItem(STORAGE_AUTH_MODE_KEY);
  window.localStorage.removeItem(STORAGE_GUEST_NICKNAME_KEY);
}

export default function Home() {
  const { t } = useTranslation();
  const [view, setView] = useState<"home" | "login" | "authed">("home");
  const [auth, setAuth] = useState<AuthState>(() => loadAuthState());
  const [loginMode, setLoginMode] = useState<LoginMode>("key");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [guestNickname, setGuestNickname] = useState(() => {
    const saved = window.localStorage.getItem(STORAGE_GUEST_NICKNAME_KEY);
    return saved ?? "";
  });
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  const languageLabel = useMemo(() => getLanguageLabel(i18n.language), [i18n.language]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scene = sceneRef.current;
    const panel = panelRef.current;
    if (!scene || !panel) return;

    const baseTiltX = 10;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    let targetX = baseTiltX;
    let targetY = 0;
    let currentX = baseTiltX;
    let currentY = 0;
    let bgTargetX = 0;
    let bgTargetY = 0;
    let bgCurrentX = 0;
    let bgCurrentY = 0;
    let rafId = 0;

    const apply = () => {
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;
      panel.style.setProperty("--panel-tilt-x", `${currentX.toFixed(3)}deg`);
      panel.style.setProperty("--panel-tilt-y", `${currentY.toFixed(3)}deg`);

      bgCurrentX += (bgTargetX - bgCurrentX) * 0.1;
      bgCurrentY += (bgTargetY - bgCurrentY) * 0.1;
      document.documentElement.style.setProperty("--bg-parallax-x", `${bgCurrentX.toFixed(2)}px`);
      document.documentElement.style.setProperty("--bg-parallax-y", `${bgCurrentY.toFixed(2)}px`);
      rafId = window.requestAnimationFrame(apply);
    };

    rafId = window.requestAnimationFrame(apply);

    const onPointerMove = (event: PointerEvent) => {
      const rect = scene.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / rect.width - 0.5;
      const ny = (event.clientY - rect.top) / rect.height - 0.5;

      targetY = clamp(nx * 6, -6, 6);
      targetX = clamp(baseTiltX + ny * -4, baseTiltX - 5, baseTiltX + 5);

      bgTargetX = clamp(nx * -18, -18, 18);
      bgTargetY = clamp(ny * -12, -12, 12);
    };

    const onPointerLeave = () => {
      targetX = baseTiltX;
      targetY = 0;
      bgTargetX = 0;
      bgTargetY = 0;
    };

    scene.addEventListener("pointermove", onPointerMove);
    scene.addEventListener("pointerleave", onPointerLeave);

    return () => {
      scene.removeEventListener("pointermove", onPointerMove);
      scene.removeEventListener("pointerleave", onPointerLeave);
      window.cancelAnimationFrame(rafId);
      document.documentElement.style.removeProperty("--bg-parallax-x");
      document.documentElement.style.removeProperty("--bg-parallax-y");
    };
  }, []);

  useEffect(() => {
    if (!isHelpOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsHelpOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHelpOpen]);

  return (
    <div className="scene" ref={sceneRef}>
      <div className="panel" ref={panelRef} role="region" aria-label="Login panel">
        <button className="btn-about" type="button">
          {t("aboutUs")}
        </button>

        <div className="early-access" aria-hidden="true">
          <div className="early-access-inner">Early Access</div>
        </div>

        <div className="panel-content">
          <div className="welcome-text">{t("welcome")}</div>

          <div className="logo-bubble" aria-label="Those Days logo">
            <div className="logo-box">
              <span className="logo-those">THOSE</span>
              <div className="logo-days-wrap">
                <span className="logo-days">DAYS</span>
              </div>
            </div>
          </div>

          {view === "home" ? (
            <>
              <div className="login-label">Login with</div>

              <div className="btn-row">
                <a
                  className="btn-login"
                  href="https://www.kozakemi.top"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("traveler")}
                </a>
                <button
                  className="btn-login"
                  type="button"
                  onClick={() => {
                    setView("login");
                  }}
                >
                  {t("vrcResident")}
                </button>
              </div>

              <div className="or-label">OR</div>

              <button className="btn-create" type="button" disabled>
                {t("createAccount")}
              </button>
            </>
          ) : view === "login" ? (
            <div className="login-card" role="group" aria-label="Login form">
              <div className="login-card-header">{t("login")}</div>
              <div className="login-card-body">
                <div className="login-mode-row" role="tablist" aria-label="Login mode">
                  <button
                    className={loginMode === "key" ? "login-mode login-mode-active" : "login-mode"}
                    type="button"
                    onClick={() => setLoginMode("key")}
                    role="tab"
                    aria-selected={loginMode === "key"}
                  >
                    {t("keyLogin")}
                  </button>
                  <button
                    className={loginMode === "guest" ? "login-mode login-mode-active" : "login-mode"}
                    type="button"
                    onClick={() => setLoginMode("guest")}
                    role="tab"
                    aria-selected={loginMode === "guest"}
                  >
                    {t("guestLogin")}
                  </button>
                </div>

                {loginMode === "key" ? (
                  <>
                    <input
                      ref={keyInputRef}
                      className="login-file-input"
                      type="file"
                      onChange={(e) => {
                        setKeyFile(e.currentTarget.files?.[0] ?? null);
                      }}
                    />
                    <button
                      className="login-file-button"
                      type="button"
                      onClick={() => keyInputRef.current?.click()}
                    >
                      {t("importKey")}
                    </button>
                    {keyFile ? (
                      <div className="login-hint">
                        {t("keySelected")}: {keyFile.name}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <input
                      className="login-input"
                      type="text"
                      placeholder={t("nicknamePlaceholder")}
                      value={guestNickname}
                      onChange={(e) => setGuestNickname(e.currentTarget.value)}
                      maxLength={24}
                      autoComplete="nickname"
                    />
                  </>
                )}

                <div className="login-actions">
                  <button
                    className="login-action"
                    type="button"
                    onClick={() => {
                      setView("home");
                      setKeyFile(null);
                      setIsHelpOpen(false);
                    }}
                  >
                    {t("back")}
                  </button>
                  <button
                    className="login-action"
                    type="button"
                    disabled={
                      loginMode === "key" ? !keyFile : !guestNickname.trim()
                    }
                    onClick={() => {
                      if (loginMode === "key") {
                        setAuth({ status: "authed", mode: "key" });
                        clearAuthPersistence();
                        setView("authed");
                        return;
                      }

                      const nickname = guestNickname.trim();
                      if (!nickname) return;
                      persistGuest(nickname);
                      setAuth({ status: "authed", mode: "guest", nickname });
                      setView("authed");
                    }}
                  >
                    {t("done")}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="login-card" role="group" aria-label="Login status">
              <div className="login-card-header">{t("login")}</div>
              <div className="login-card-body">
                <div className="login-hint">
                  {auth.status === "authed" && auth.mode === "key" ? t("loggedInAsKey") : null}
                  {auth.status === "authed" && auth.mode === "guest" ? (
                    <>
                      {t("loggedInAsGuest")}: {auth.nickname}
                    </>
                  ) : null}
                </div>
                <div className="login-actions">
                  <button
                    className="login-action"
                    type="button"
                    onClick={() => {
                      setView("home");
                      setIsHelpOpen(false);
                    }}
                  >
                    {t("back")}
                  </button>
                  <button
                    className="login-action"
                    type="button"
                    onClick={() => {
                      setAuth({ status: "anonymous" });
                      clearAuthPersistence();
                      setKeyFile(null);
                      setView("home");
                    }}
                  >
                    {t("logout")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {view === "login" ? (
          <button
            className="help-switch"
            type="button"
            aria-label="Help"
            onClick={() => setIsHelpOpen(true)}
          >
            ?
          </button>
        ) : null}

        <button
          className="lang-switch"
          type="button"
          onClick={() => {
            const next = getNextLanguage(i18n.language);
            void i18n.changeLanguage(next);
            persistLanguage(next);
          }}
        >
          {languageLabel}
        </button>
      </div>

      {view === "login" && isHelpOpen
        ? createPortal(
            <div
              className="help-modal-backdrop"
              role="presentation"
              onClick={() => setIsHelpOpen(false)}
            >
              <div
                className="help-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t("loginHelpTitle")}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="help-modal-close"
                  type="button"
                  aria-label="Close"
                  onClick={() => setIsHelpOpen(false)}
                >
                  ×
                </button>
                <div className="help-modal-title">{t("loginHelpTitle")}</div>
                <div className="help-modal-body">{t("loginHelpBody")}</div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
