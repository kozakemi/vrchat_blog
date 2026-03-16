import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const STORAGE_KEY = "td_lang";

type AppLanguage = "zh" | "ja" | "en";

function normalizeToAppLanguage(language: string): AppLanguage {
  const lower = language.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("ja")) return "ja";
  return "en";
}

function getInitialLanguage(): AppLanguage {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "zh" || stored === "ja" || stored === "en") return stored;

  const preferred = window.navigator.languages?.[0] ?? window.navigator.language ?? "en";
  const initial = normalizeToAppLanguage(preferred);
  window.localStorage.setItem(STORAGE_KEY, initial);
  return initial;
}

export function persistLanguage(language: AppLanguage) {
  window.localStorage.setItem(STORAGE_KEY, language);
}

i18n.use(initReactI18next).init({
  resources: {
    zh: {
      translation: {
        aboutUs: "关于我们",
        welcome: "欢迎来到这个世界",
        traveler: "现实旅人",
        vrcResident: "VRC住民",
        createAccount: "创建账号",
        login: "登录",
        keyLogin: "密钥登录",
        guestLogin: "游客身份",
        importKey: "导入密钥文件",
        keySelected: "已选择",
        nicknamePlaceholder: "输入昵称…",
        back: "返回",
        done: "进入",
        logout: "退出登录",
        loggedInAsKey: "已以密钥身份进入",
        loggedInAsGuest: "已以游客身份进入",
        loginHelpTitle: "登录说明",
        loginHelpBody:
          "密钥登录：适用于拥有本站密钥文件的用户；导入密钥后进入。\n游客身份：输入昵称即可进入（不提供真实账号登录）。",
      },
    },
    ja: {
      translation: {
        aboutUs: "私たちについて",
        welcome: "この世界へようこそ",
        traveler: "現実の旅人",
        vrcResident: "VRC住民",
        createAccount: "アカウント作成",
        login: "ログイン",
        keyLogin: "キーでログイン",
        guestLogin: "ゲスト",
        importKey: "キーファイルを選択",
        keySelected: "選択済み",
        nicknamePlaceholder: "ニックネーム…",
        back: "戻る",
        done: "入る",
        logout: "ログアウト",
        loggedInAsKey: "キーで入室しました",
        loggedInAsGuest: "ゲストとして入室しました",
        loginHelpTitle: "ログイン説明",
        loginHelpBody:
          "キーでログイン：サイトのキーファイルを持っているユーザー向け。選択後に入室します。\nゲスト：ニックネームを入力して入室（実際のアカウントログインは未対応）。",
      },
    },
    en: {
      translation: {
        aboutUs: "About Us",
        welcome: "Welcome to the world of",
        traveler: "Traveler",
        vrcResident: "VRC Resident",
        createAccount: "Create Account",
        login: "LOGIN",
        keyLogin: "KEY LOGIN",
        guestLogin: "GUEST",
        importKey: "Import Key File",
        keySelected: "Selected",
        nicknamePlaceholder: "Enter nickname…",
        back: "Back",
        done: "Enter",
        logout: "Log out",
        loggedInAsKey: "Entered with key",
        loggedInAsGuest: "Entered as guest",
        loginHelpTitle: "Login Help",
        loginHelpBody:
          "Key login: for users who have this site's key file; import the key to enter.\nGuest: enter a nickname to enter (no real account login).",
      },
    },
  },
  lng: getInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
