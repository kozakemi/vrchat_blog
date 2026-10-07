import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n, { persistLanguage } from "@/i18n";
import { clearAlbumBlobCache } from "@/lib/albumBlobCache";
import {
  isAdminKeyFile,
  keyFileToDownloadJson,
  parseKeyFileJson,
  validateKeyFile,
  type KeyFileV1,
} from "@/lib/keyFile";
import { PUBLIC_ZONES, canSelfRegister } from "@/lib/publicZones";
import { useSessionAuthStore } from "@/store/sessionAuthStore";

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

type Tab = "login" | "register";

/**
 * 登录页（本站唯一入口）。
 *
 * - 登录：导入密钥文件
 * - 注册：按 src/config/public-zones.json 里的「公开区」现场生成并下载密钥文件
 *
 * 登录态存放在 localStorage（见 store/sessionAuthStore），刷新与重开浏览器都不会掉。
 * 相册页/管理页只认这个会话，不再有独立的准入标记。
 */
export default function Home() {
  const { t, i18n: i18nInstance } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const keySession = useSessionAuthStore((s) => s.keySession);
  const setKeySession = useSessionAuthStore((s) => s.setKeySession);

  const [tab, setTab] = useState<Tab>("login");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  /** 从相册页被请回登录页时，用一句人话说明原因，并清掉该标记避免刷新后重复出现 */
  const needKey = Boolean((location.state as { needKey?: boolean } | null)?.needKey);
  useEffect(() => {
    if (!needKey) return;
    navigate("/", { replace: true, state: null });
  }, [needKey, navigate]);

  useEffect(() => {
    if (!isHelpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHelpOpen]);

  function downloadTextFile(filename: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleKeyLogin() {
    if (!keyFile) return;
    let text: string;
    try {
      text = await keyFile.text();
    } catch {
      setError(t("errKeyFileRead"));
      return;
    }

    let data: KeyFileV1;
    try {
      data = parseKeyFileJson(text);
    } catch (e) {
      const raw = e instanceof Error ? e.message : "";
      setError(raw.includes("schemaVersion") ? t("errKeyFileVersion") : t("errKeyFileNotJson"));
      return;
    }

    if (validateKeyFile(data)) {
      setError(t("errKeyFileInvalid"));
      return;
    }

    setError(null);
    setNotice(null);
    setKeySession({
      username: data.username.trim(),
      zones: data.zones,
      roles: data.roles ?? [],
      isAdmin: isAdminKeyFile(data),
    });
    navigate("/album");
  }

  function handleRegister() {
    const name = nickname.trim();
    if (!name) return;
    if (!canSelfRegister()) {
      setError(t("errRegisterUnavailable"));
      return;
    }

    const data: KeyFileV1 = {
      schemaVersion: 1,
      username: name,
      roles: [],
      zones: PUBLIC_ZONES,
      createdAt: new Date().toISOString(),
    };
    if (validateKeyFile(data)) {
      // 只有 public-zones.json 配错才会走到这里
      setError(t("errRegisterConfig"));
      return;
    }

    const filename = `key-${name.replace(/[^\w.-]+/g, "_") || "guest"}.json`;
    downloadTextFile(filename, keyFileToDownloadJson(data));
    setError(null);
    setKeySession({ username: name, zones: data.zones, roles: [], isAdmin: false });
    setNotice(t("registerNotice", { file: filename }));
  }

  function handleLogout() {
    // 退出时立刻丢弃已解密的图片缓存，避免残留可被后续低权限会话复用
    clearAlbumBlobCache();
    setKeySession(null);
    setKeyFile(null);
    setNickname("");
    setNotice(null);
    setError(null);
    setTab("login");
  }

  const languageLabel = getLanguageLabel(i18nInstance.language);
  const langSwitch = (
    <button
      className="lang-switch"
      type="button"
      onClick={() => {
        const next = getNextLanguage(i18nInstance.language);
        void i18n.changeLanguage(next);
        persistLanguage(next);
      }}
    >
      {languageLabel}
    </button>
  );

  /** 站点标识：登录页顶部原有的 THOSE DAYS 标志 */
  const logo = (
    <div className="logo-bubble" aria-label="Those Days">
      <div className="logo-box">
        <span className="logo-those">THOSE</span>
        <div className="logo-days-wrap">
          <span className="logo-days">DAYS</span>
        </div>
      </div>
    </div>
  );

  // ---- 已登录：给一个明确的「进入相册」，并保留退出登录 ----
  if (keySession) {
    return (
      <div className="scene">
        <div className="panel" role="region" aria-label={t("login")}>
          <div className="panel-content">
            {logo}
            <div className="login-card" role="group" aria-label={t("login")}>
              <div className="login-card-header">{t("login")}</div>
              <div className="login-card-body">
                {notice ? <div className="login-hint login-hint-ok">{notice}</div> : null}
                <div className="login-hint">
                  {t("loggedInAs", { name: keySession.username })}
                </div>
                <div className="login-actions">
                  <button
                    className="login-action"
                    type="button"
                    onClick={() => navigate("/album")}
                  >
                    {t("enterAlbum")}
                  </button>
                  <button className="login-action" type="button" onClick={handleLogout}>
                    {t("logout")}
                  </button>
                </div>
              </div>
            </div>
          </div>
          {langSwitch}
        </div>
      </div>
    );
  }

  // ---- 未登录：登录 / 注册 ----
  return (
    <div className="scene">
      <div className="panel" role="region" aria-label={t("login")}>
        <div className="panel-content">
          {logo}
          <div className="login-card" role="group" aria-label={t("login")}>
            <div className="login-card-header">{t("login")}</div>
            <div className="login-card-body">
              <div className="login-mode-row" role="tablist" aria-label={t("login")}>
                <button
                  className={tab === "login" ? "login-mode login-mode-active" : "login-mode"}
                  type="button"
                  role="tab"
                  aria-selected={tab === "login"}
                  onClick={() => {
                    setTab("login");
                    setError(null);
                  }}
                >
                  {t("keyLogin")}
                </button>
                <button
                  className={tab === "register" ? "login-mode login-mode-active" : "login-mode"}
                  type="button"
                  role="tab"
                  aria-selected={tab === "register"}
                  onClick={() => {
                    setTab("register");
                    setError(null);
                  }}
                >
                  {t("register")}
                </button>
              </div>

              {needKey && !error ? (
                <div className="login-hint login-hint-warn">{t("needKeyNotice")}</div>
              ) : null}
              {error ? <div className="login-hint login-hint-error">{error}</div> : null}

              {tab === "login" ? (
                <>
                  <input
                    ref={keyInputRef}
                    className="login-file-input"
                    type="file"
                    accept=".json,application/json"
                    aria-label={t("importKey")}
                    onChange={(e) => {
                      setKeyFile(e.currentTarget.files?.[0] ?? null);
                      setError(null);
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
                  value={nickname}
                  onChange={(e) => {
                    setNickname(e.currentTarget.value);
                    setError(null);
                  }}
                  maxLength={24}
                  autoComplete="nickname"
                  aria-label={t("nicknamePlaceholder")}
                />
              )}

              <div className="login-actions">
                <button
                  className="login-action"
                  type="button"
                  disabled={tab === "login" ? !keyFile : !nickname.trim()}
                  onClick={() => {
                    if (tab === "login") void handleKeyLogin();
                    else handleRegister();
                  }}
                >
                  {tab === "login" ? t("enterAlbum") : t("generateKey")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <button
          className="help-switch"
          type="button"
          aria-label={t("loginHelpTitle")}
          onClick={() => setIsHelpOpen(true)}
        >
          ?
        </button>
        {langSwitch}
      </div>

      {isHelpOpen
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
                  aria-label={t("close")}
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
