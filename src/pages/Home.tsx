import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
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

type LoginEffectState =
  | {
      mode: LoginMode;
      accountLabel: string;
    }
  | null;

type JoinStatus = "connecting" | "joining";

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
  const navigate = useNavigate();
  const [view, setView] = useState<"home" | "login" | "authed" | "joining">("home");
  const [auth, setAuth] = useState<AuthState>(() => loadAuthState());
  const [loginMode, setLoginMode] = useState<LoginMode>("key");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [guestNickname, setGuestNickname] = useState(() => {
    const saved = window.localStorage.getItem(STORAGE_GUEST_NICKNAME_KEY);
    return saved ?? "";
  });
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [loginEffect, setLoginEffect] = useState<LoginEffectState>(null);
  const [loginProgress, setLoginProgress] = useState(0);
  const [joinStatus, setJoinStatus] = useState<JoinStatus>("connecting");
  const [joinAccountLabel, setJoinAccountLabel] = useState<string>("");
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

  useEffect(() => {
    if (!loginEffect) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLoginProgress(1);
      return;
    }

    let rafId = 0;
    const startAt = performance.now();
    const durationMs = 2400;

    const tick = (now: number) => {
      const t01 = Math.min(1, (now - startAt) / durationMs);
      const eased = 1 - Math.pow(1 - t01, 3);
      setLoginProgress(eased);
      if (t01 < 1) rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [loginEffect]);

  useEffect(() => {
    if (!loginEffect) return;
    if (loginProgress < 1) return;

    if (loginEffect.mode === "key") {
      setAuth({ status: "authed", mode: "key" });
      clearAuthPersistence();
    } else {
      const nickname = loginEffect.accountLabel;
      persistGuest(nickname);
      setAuth({ status: "authed", mode: "guest", nickname });
    }

    setJoinAccountLabel(loginEffect.accountLabel);
    setJoinStatus("connecting");
    setView("joining");
    setLoginEffect(null);
  }, [loginEffect, loginProgress]);

  useEffect(() => {
    if (!loginEffect) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLoginEffect(null);
      setLoginProgress(0);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loginEffect]);

  useEffect(() => {
    if (view !== "joining") return;

    setJoinStatus("connecting");
    const t1 = window.setTimeout(() => setJoinStatus("joining"), 1400);
    const t2 = window.setTimeout(() => {
      navigate("/album");
    }, 2600);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [navigate, view]);

  if (view === "joining") {
    return (
      <div className="fullscreen">
        <div className="fullscreen-content">
          <div className="join-screen" role="status" aria-live="polite">
            <div className="join-preview" aria-hidden="true" />
            <div className="join-status">
              <div className="join-status-text">
                {joinStatus === "connecting" ? t("connecting") : t("joining")}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scene" ref={sceneRef}>
      <div className="panel" ref={panelRef} role="region" aria-label="Login panel">
        {!loginEffect && view === "home" ? (
          <>
            <button className="btn-about" type="button">
              {t("aboutUs")}
            </button>

            <div className="early-access" aria-hidden="true">
              <div className="early-access-inner">Early Access</div>
            </div>
          </>
        ) : null}

        <div className="panel-content">
          {loginEffect ? (
            <div className="login-effect-backdrop" role="presentation">
              <div
                className="login-effect"
                role="dialog"
                aria-modal="true"
                aria-label={t("loggingInTitle")}
                style={{
                  ["--progress" as never]: `${Math.round(loginProgress * 100)}`,
                }}
              >
                <div className="login-effect-ring" aria-hidden="true" />
                <div className="login-effect-inner">
                  <div className="login-effect-corners">
                    <span>0%</span>
                    <span>100%</span>
                  </div>
                  <svg className="login-effect-wave" viewBox="0 0 240 44" aria-hidden="true">
                    <path
                      d="M0 22 C 16 10, 28 10, 44 22 S 72 34, 88 22 S 116 10, 132 22 S 160 34, 176 22 S 204 10, 220 22 S 232 34, 240 22"
                      fill="none"
                      stroke="rgba(255,255,255,0.72)"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="login-effect-title">{t("loggingInTitle")}</div>
                  <div className="login-effect-subtitle">
                    {loginEffect.mode === "key"
                      ? t("loggingInWithKey", { account: loginEffect.accountLabel })
                      : t("loggingInWithGuest", { account: loginEffect.accountLabel })}
                  </div>
                  <button
                    className="login-effect-cancel"
                    type="button"
                    onClick={() => {
                      setLoginEffect(null);
                      setLoginProgress(0);
                    }}
                  >
                    {t("cancel")}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {(
                <>
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
                            className={
                              loginMode === "key" ? "login-mode login-mode-active" : "login-mode"
                            }
                            type="button"
                            onClick={() => setLoginMode("key")}
                            role="tab"
                            aria-selected={loginMode === "key"}
                          >
                            {t("keyLogin")}
                          </button>
                          <button
                            className={
                              loginMode === "guest"
                                ? "login-mode login-mode-active"
                                : "login-mode"
                            }
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
                          <input
                            className="login-input"
                            type="text"
                            placeholder={t("nicknamePlaceholder")}
                            value={guestNickname}
                            onChange={(e) => setGuestNickname(e.currentTarget.value)}
                            maxLength={24}
                            autoComplete="nickname"
                          />
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
                            disabled={loginMode === "key" ? !keyFile : !guestNickname.trim()}
                            onClick={() => {
                              if (loginMode === "key") {
                                const name = keyFile ? keyFile.name : "Key";
                                setLoginProgress(0);
                                setLoginEffect({ mode: "key", accountLabel: name });
                                return;
                              }

                              const nickname = guestNickname.trim();
                              if (!nickname) return;
                              setLoginProgress(0);
                              setLoginEffect({ mode: "guest", accountLabel: nickname });
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
                          {auth.status === "authed" && auth.mode === "key"
                            ? t("loggedInAsKey")
                            : null}
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
                </>
              )}
            </>
          )}
        </div>

        {view === "login" && !loginEffect ? (
          <button
            className="help-switch"
            type="button"
            aria-label="Help"
            onClick={() => setIsHelpOpen(true)}
          >
            ?
          </button>
        ) : null}

        {!loginEffect ? (
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
        ) : null}
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
